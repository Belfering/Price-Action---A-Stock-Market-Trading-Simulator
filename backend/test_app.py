import json
from uuid import uuid4

import pandas as pd
from fastapi.testclient import TestClient

from backend.market_data import sanitize_ohlc_outliers
from backend.main import (
    DISPLAY_SESSION_DATE,
    MARKET_DATA_STORE,
    PROFILE_STORE,
    RELATIVE_VOLUME_BASE,
    allocate_volume_deltas,
    app,
    df_for_date,
    normalized_df_for_date,
    session_dates,
    synthetic_premarket_candles,
)
from backend.scenario_classifier import HIDDEN_TAGS, hidden_day_tags


client = TestClient(app)


def first_session_date():
    return session_dates()[0]


def last_session_date(asset_class: str | None = None):
    if asset_class is None:
        return session_dates()[-1]
    refs = [ref for ref in MARKET_DATA_STORE.session_refs() if ref.asset_class == asset_class]
    return sorted({ref.date for ref in refs})[-1]


def start_session(payload=None):
    response = client.post(
        "/api/sessions/start",
        json=payload
        or {
            "assetClass": "Random",
            "scenario": "Random",
            "timeframe": "1m",
            "startingCapital": 100000,
            "replaySpeed": "3x Speed",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["sessionId"]


def test_ohlc_sanitizer_repairs_bad_wick_prints():
    timestamps = pd.date_range("2023-01-03 09:30", periods=4, freq="1min")
    df = pd.DataFrame(
        [
            {"timestamp": timestamps[0], "symbol": "SPY", "open": 100.00, "high": 100.05, "low": 99.95, "close": 100.02, "volume": 1000},
            {"timestamp": timestamps[1], "symbol": "SPY", "open": 100.02, "high": 100.08, "low": 10.00, "close": 100.04, "volume": 1000},
            {"timestamp": timestamps[2], "symbol": "SPY", "open": 100.04, "high": 500.00, "low": 100.00, "close": 100.06, "volume": 1000},
            {"timestamp": timestamps[3], "symbol": "SPY", "open": 100.06, "high": 100.10, "low": 100.02, "close": 100.08, "volume": 1000},
        ]
    )

    repaired = sanitize_ohlc_outliers(df)

    assert repaired.loc[1, "low"] > 95
    assert repaired.loc[2, "high"] < 105
    assert repaired.loc[1, "high"] >= max(repaired.loc[1, "open"], repaired.loc[1, "close"])
    assert repaired.loc[2, "low"] <= min(repaired.loc[2, "open"], repaired.loc[2, "close"])


def test_health_loads_spy_dataset():
    response = client.get("/api/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["rows"] >= 780
    assert payload["ticker"] == "SPY"
    assert payload["sessionCount"] >= 2
    assert "dates" not in payload


def test_market_data_resolves_uploaded_windows_catalog_paths():
    session_date = first_session_date()
    broken_path = rf"C:\old-machine\repo\data\candles\symbol=SPY\year={session_date[:4]}\candles.parquet"
    resolved = MARKET_DATA_STORE.resolve_parquet_path(broken_path, "SPY", session_date)

    assert resolved.exists()
    assert resolved.name == "candles.parquet"


def test_auth_profile_roundtrip_and_logout():
    auth_client = TestClient(app)
    login_response = auth_client.post("/api/auth/login", json={"username": "1", "password": "1"})
    assert login_response.status_code == 200, login_response.text
    assert login_response.json()["user"]["username"] == "1"
    assert login_response.json()["user"]["isAdmin"] is True

    me_response = auth_client.get("/api/auth/me")
    assert me_response.status_code == 200
    assert me_response.json()["authenticated"] is True

    profile_response = auth_client.get("/api/me/profile")
    assert profile_response.status_code == 200
    profile = profile_response.json()
    assert {"settings", "setup", "chartSetupUi", "chartTemplates", "activeTemplateId", "history"}.issubset(profile)

    update_response = auth_client.put(
        "/api/me/profile",
        json={
            **profile,
            "settings": {"defaultReplaySpeed": "3x Speed"},
            "setup": {"scenario": "Gap Up"},
            "chartSetupUi": {"mode": "appearance", "zone": "chart"},
            "chartTemplates": [{"id": "default", "name": "Default"}],
            "activeTemplateId": "default",
            "history": [],
        },
    )
    assert update_response.status_code == 200, update_response.text
    updated = update_response.json()
    assert updated["settings"]["defaultReplaySpeed"] == "3x Speed"
    assert updated["activeTemplateId"] == "default"

    logout_response = auth_client.post("/api/auth/logout")
    assert logout_response.status_code == 200
    assert auth_client.get("/api/auth/me").status_code == 401


def test_analytics_visit_event_and_dashboard():
    auth_client = TestClient(app)
    visitor_id = "test-visitor-analytics"
    visit_id = "test-visit-analytics"

    visit_response = auth_client.post(
        "/api/analytics/visit",
        json={"visitorId": visitor_id, "visitId": visit_id, "path": "/app/login", "referrer": ""},
    )
    assert visit_response.status_code == 200, visit_response.text

    event_response = auth_client.post(
        "/api/analytics/event",
        json={"visitorId": visitor_id, "visitId": visit_id, "eventName": "page_view", "path": "/app/login", "payload": {"view": "login"}},
    )
    assert event_response.status_code == 200, event_response.text

    assert auth_client.get("/api/analytics/dashboard").status_code == 401
    login_response = auth_client.post("/api/auth/login", json={"username": "1", "password": "1"})
    assert login_response.status_code == 200

    linked_event_response = auth_client.post(
        "/api/analytics/event",
        json={"visitorId": visitor_id, "visitId": visit_id, "eventName": "login_success", "path": "/app/login", "payload": {"password": "blocked"}},
    )
    assert linked_event_response.status_code == 200, linked_event_response.text

    dashboard_response = auth_client.get("/api/analytics/dashboard")
    assert dashboard_response.status_code == 200, dashboard_response.text
    dashboard = dashboard_response.json()
    assert dashboard["totals"]["users"] >= 1
    assert dashboard["totals"]["visitors"] >= 1
    assert dashboard["totals"]["visits"] >= 1
    assert any(item["name"] == "login_success" for item in dashboard["eventsByName"])
    assert any(item["path"] == "/app/login" for item in dashboard["topPages"])

    non_admin_username = f"analytics_non_admin_{uuid4().hex}"
    non_admin_password = "test-password"
    PROFILE_STORE.create_user(non_admin_username, non_admin_password, force_password_change=False, is_admin=False)
    non_admin_client = TestClient(app)
    non_admin_login = non_admin_client.post("/api/auth/login", json={"username": non_admin_username, "password": non_admin_password})
    assert non_admin_login.status_code == 200, non_admin_login.text
    assert non_admin_login.json()["user"]["isAdmin"] is False
    assert non_admin_client.get("/api/analytics/dashboard").status_code == 403


def test_scoreboard_uses_score_tables_and_saved_replays():
    auth_client = TestClient(app)
    login_response = auth_client.post("/api/auth/login", json={"username": "1", "password": "1", "displayName": "Trader One"})
    assert login_response.status_code == 200, login_response.text

    session_id = start_session({"assetClass": "Equity", "scenario": "Random", "practiceDate": first_session_date(), "replaySpeed": "5x Speed", "hardcore": True})
    replay = client.get(f"/api/sessions/{session_id}/replay").json()["ticks"]
    first_price = replay[0]["price"]
    score_response = auth_client.post(
        f"/api/sessions/{session_id}/score",
        json={
            "startingCapital": 100000,
            "trades": [{"side": "buy", "quantity": 1000 / first_price, "price": first_price, "tickIndex": 0}],
        },
    )
    assert score_response.status_code == 200, score_response.text
    score = score_response.json()
    assert score["hardcore"] is True
    assert score["scoreId"]

    dashboard_response = auth_client.get("/api/scoreboard")
    assert dashboard_response.status_code == 200, dashboard_response.text
    dashboard = dashboard_response.json()
    assert any(item["scoreId"] == score["scoreId"] for item in dashboard["personal"])
    assert all("username" not in item for item in dashboard["global31d"])
    assert any(item["displayName"] == "Trader One" for item in dashboard["global31d"])

    save_response = auth_client.post(f"/api/replays/{score['scoreId']}/save")
    assert save_response.status_code == 200, save_response.text
    assert any(item["scoreId"] == score["scoreId"] for item in save_response.json()["replays"])

    delete_response = auth_client.delete(f"/api/replays/{score['scoreId']}")
    assert delete_response.status_code == 200, delete_response.text
    assert not any(item["scoreId"] == score["scoreId"] for item in delete_response.json()["replays"])


def test_non_hardcore_score_does_not_write_scoreboard_entry():
    auth_client = TestClient(app)
    assert auth_client.post("/api/auth/login", json={"username": "1", "password": "1"}).status_code == 200
    before = auth_client.get("/api/scoreboard").json()["personal"]

    session_id = start_session({"assetClass": "Equity", "scenario": "Random", "practiceDate": first_session_date(), "replaySpeed": "5x Speed", "hardcore": False})
    score_response = auth_client.post(f"/api/sessions/{session_id}/score", json={"startingCapital": 100000, "trades": []})
    assert score_response.status_code == 200, score_response.text
    assert "scoreId" not in score_response.json()

    after = auth_client.get("/api/scoreboard").json()["personal"]
    assert len(after) == len(before)


def test_legacy_profile_history_migrates_once_and_replays_cap_at_20():
    user = PROFILE_STORE.create_user(f"legacy_score_{uuid4().hex}", "test-password", force_password_change=False)
    legacy_score = {
        "ticker": "SPY",
        "assetClass": "Equity",
        "scenario": "Random",
        "score": 12.5,
        "baseScore": 12.5,
        "returnPct": 1.25,
        "finalPnl": 1250,
        "maxDrawdownPct": -0.2,
        "numberOfTrades": 2,
        "entryTimingScore": 0.7,
        "exitTimingScore": 0.6,
        "completedAt": "2020-01-03T16:00:00+00:00",
        "hardcore": True,
    }
    migration_hash = PROFILE_STORE._score_migration_hash(user["id"], legacy_score)

    with PROFILE_STORE.connection() as conn:
        placeholder = PROFILE_STORE._placeholder()
        if PROFILE_STORE.is_postgres:
            from psycopg.types.json import Jsonb

            conn.cursor().execute(f"UPDATE user_profiles SET history_json = {placeholder} WHERE user_id = {placeholder}", [Jsonb([legacy_score]), user["id"]])
        else:
            conn.cursor().execute(f"UPDATE user_profiles SET history_json = {placeholder} WHERE user_id = {placeholder}", [json.dumps([legacy_score]), user["id"]])
        PROFILE_STORE.migrate_profile_history(conn)
        PROFILE_STORE.migrate_profile_history(conn)
        rows = conn.cursor().execute(f"SELECT score_id FROM score_entries WHERE migration_hash = {placeholder}", [migration_hash]).fetchall()

    assert len(rows) == 1
    dashboard = PROFILE_STORE.scoreboard_dashboard(user["id"])
    assert any(item["finalPnl"] == 1250 for item in dashboard["personal"])

    score_ids = []
    for index in range(21):
        inserted = PROFILE_STORE.insert_score_entry(
            user["id"],
            user["displayName"],
            {
                **legacy_score,
                "score": index + 1,
                "finalPnl": index * 100,
                "completedAt": f"2020-02-{index + 1:02d}T16:00:00+00:00",
            },
        )
        score_ids.append(inserted["scoreId"])
        PROFILE_STORE.save_replay(user["id"], inserted["scoreId"])

    capped = PROFILE_STORE.scoreboard_dashboard(user["id"])["replays"]
    assert len(capped) == 20
    assert score_ids[-1] in {item["scoreId"] for item in capped}


def test_session_options_serializes_metadata_flags():
    response = client.get("/api/sessions/options")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert "SPY" in payload["tickers"]
    assert "BTCUSD" in payload["tickers"]
    assert "ETHUSD" in payload["tickers"]
    assert "assets" in payload
    assert any(item["label"] == "SPY" and item["assetClass"] == "Equity" for item in payload["assets"])
    assert any(item["label"] == "QQQ" and item["description"] == "NASDAQ" for item in payload["assets"])
    assert not any(item["label"] == "ARKK" for item in payload["assets"])
    assert payload["startingCapital"] == [10000, 100000, 1000000]
    assert isinstance(payload["metadata"][0]["scenarioFlags"]["High Volatility"], bool)
    assert "date" not in payload["metadata"][0]
    assert "dailyReturn" not in payload["metadata"][0]
    scenario_labels = {item["label"] for item in payload["scenarios"]}
    assert {"Above 200 SMA", "Below 200 SMA", "Gap Up", "Gap Down", "Large Premarket Volume Increase", "Large Premarket Volume Decrease"}.issubset(scenario_labels)
    assert "Gap Up With Volume" not in scenario_labels
    assert not scenario_labels.intersection(HIDDEN_TAGS)


def test_start_session_serializes_hardcore_mode():
    response = client.post(
        "/api/sessions/start",
        json={"assetClass": "Equity", "scenario": "Random", "practiceDate": first_session_date(), "replaySpeed": "3x Speed", "hardcore": True},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["hardcore"] is True
    assert "hiddenTags" not in payload
    assert "priceNormalization" not in payload
    assert payload["date"] == DISPLAY_SESSION_DATE


def test_start_session_can_filter_specific_asset():
    response = client.post(
        "/api/sessions/start",
        json={"assetClass": "Equity", "asset": "SPY", "scenario": "Random", "practiceDate": first_session_date(), "replaySpeed": "3x Speed"},
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["ticker"] == "SPY"
    assert payload["date"] == DISPLAY_SESSION_DATE


def test_start_session_can_pin_start_time():
    response = client.post(
        "/api/sessions/start",
        json={"assetClass": "Equity", "scenario": "Random", "practiceDate": first_session_date(), "replaySpeed": "3x Speed", "startTime": "14:00"},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["startCandleIndex"] == 270
    assert payload["startTickIndex"] == 5400


def test_start_session_bounds_spawn_time():
    early_response = client.post(
        "/api/sessions/start",
        json={"assetClass": "Equity", "scenario": "Random", "practiceDate": first_session_date(), "replaySpeed": "3x Speed", "startTime": "09:27"},
    )
    late_response = client.post(
        "/api/sessions/start",
        json={"assetClass": "Equity", "scenario": "Random", "practiceDate": first_session_date(), "replaySpeed": "3x Speed", "startTime": "14:01"},
    )
    first_spawn_response = client.post(
        "/api/sessions/start",
        json={"assetClass": "Equity", "scenario": "Random", "practiceDate": first_session_date(), "replaySpeed": "3x Speed", "startTime": "09:28"},
    )

    assert early_response.status_code == 400
    assert late_response.status_code == 400
    assert first_spawn_response.status_code == 200, first_spawn_response.text
    assert first_spawn_response.json()["startCandleIndex"] == 0


def test_start_session_accepts_regular_start_time_choices():
    response = client.post(
        "/api/sessions/start",
        json={"assetClass": "Equity", "scenario": "Random", "practiceDate": first_session_date(), "replaySpeed": "3x Speed", "startTime": "09:43"},
    )
    second_response = client.post(
        "/api/sessions/start",
        json={"assetClass": "Equity", "scenario": "Random", "practiceDate": first_session_date(), "replaySpeed": "3x Speed", "startTime": "10:13"},
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["startTime"] == "09:43"
    assert payload["startCandleIndex"] == 13
    assert payload["startTickIndex"] == 260
    assert second_response.status_code == 200, second_response.text
    assert second_response.json()["startCandleIndex"] == 43


def test_replay_tick_count_matches_selected_speed():
    session_id = start_session({"assetClass": "Equity", "scenario": "Random", "practiceDate": first_session_date(), "replaySpeed": "5x Speed"})
    response = client.get(f"/api/sessions/{session_id}/replay")
    assert response.status_code == 200
    ticks = response.json()["ticks"]
    assert len(ticks) == 4680
    assert ticks[0]["phase"] == "open"
    assert ticks[11]["phase"] == "close"
    assert {"candleOpen", "candleHigh", "candleLow", "candleClose", "nextCandleVolume", "nextCandleRange"}.issubset(ticks[0])


def test_session_prices_are_normalized_to_100_open():
    session_date = first_session_date()
    raw_df = df_for_date(session_date)
    session_id = start_session({"assetClass": "Equity", "scenario": "Random", "practiceDate": session_date, "replaySpeed": "5x Speed"})
    candles_payload = client.get(f"/api/sessions/{session_id}/candles?timeframe=1m").json()
    replay_payload = client.get(f"/api/sessions/{session_id}/replay").json()

    regular_candles = [candle for candle in candles_payload["candles"] if candle["sessionSegment"] == "regular"]
    premarket_candles = [candle for candle in candles_payload["candles"] if candle["sessionSegment"] == "pre_market"]
    factor = 100 / float(raw_df.iloc[0]["open"])

    assert regular_candles[0]["open"] == 100
    assert regular_candles[0]["timestamp"].startswith(f"{DISPLAY_SESSION_DATE}T09:30:00")
    assert replay_payload["ticks"][0]["price"] == 100
    assert replay_payload["ticks"][0]["timestamp"].startswith(f"{DISPLAY_SESSION_DATE}T09:30:00")
    assert replay_payload["ticks"][0]["candleOpen"] == 100
    assert abs(regular_candles[-1]["close"] - (float(raw_df.iloc[-1]["close"]) * factor)) < 0.0001
    assert abs(premarket_candles[-1]["close"] - 100) < 0.0001
    assert max(candle["volume"] for candle in regular_candles) < max(int(raw_df["volume"].max()), RELATIVE_VOLUME_BASE + 1)


def test_intracandle_path_has_anchors_random_ticks_and_volume_build():
    session_id = start_session({"assetClass": "Equity", "scenario": "Random", "practiceDate": first_session_date(), "replaySpeed": "3x Speed"})
    ticks = client.get(f"/api/sessions/{session_id}/replay").json()["ticks"]
    first_candle = ticks[:20]
    phases = [tick["phase"] for tick in first_candle]

    assert phases.count("open") == 1
    assert phases.count("high") == 1
    assert phases.count("low") == 1
    assert phases.count("close") == 1
    assert phases.count("random") == 16
    assert abs(phases.index("high") - phases.index("low")) >= 2

    high = next(tick["price"] for tick in first_candle if tick["phase"] == "high")
    low = next(tick["price"] for tick in first_candle if tick["phase"] == "low")
    random_prices = [tick["price"] for tick in first_candle if tick["phase"] == "random"]
    assert all(low <= price <= high for price in random_prices)

    volume_deltas = [tick["volumeDelta"] for tick in first_candle]
    assert all(delta >= 0 for delta in volume_deltas)
    assert sum(volume_deltas) == first_candle[-1]["candleVolume"]
    assert first_candle[-1]["volume"] == first_candle[-1]["candleVolume"]


def test_volume_allocation_weights_larger_price_moves_more_heavily():
    path = [
        ("open", 100.0),
        ("random", 100.1),
        ("high", 101.5),
        ("random", 101.6),
        ("close", 101.7),
    ]
    deltas = allocate_volume_deltas(path, 1000)

    assert sum(deltas) == 1000
    assert deltas[2] > deltas[1]


def test_candle_resampling():
    session_date = first_session_date()
    session_id = start_session({"assetClass": "Equity", "scenario": "Random", "practiceDate": session_date})
    response = client.get(f"/api/sessions/{session_id}/candles?timeframe=5m")
    assert response.status_code == 200
    candles = response.json()["candles"]
    assert len(candles) > 78
    assert candles[0]["timestamp"].startswith(f"{DISPLAY_SESSION_DATE}T04:00:00")
    assert candles[0]["sessionSegment"] == "pre_market"
    assert candles[0]["source"] == "synthetic"
    assert any(candle["timestamp"].startswith(f"{DISPLAY_SESSION_DATE}T09:30:00") and candle["sessionSegment"] == "regular" for candle in candles)


def test_synthetic_premarket_generation_is_deterministic_and_anchored():
    session_date = first_session_date()
    session_df = df_for_date(session_date)
    first = synthetic_premarket_candles(session_df, "SPY", session_date)
    second = synthetic_premarket_candles(session_df, "SPY", session_date)

    assert len(first) == 330
    assert first.iloc[0]["timestamp"].strftime("%H:%M") == "04:00"
    assert first.iloc[-1]["timestamp"].strftime("%H:%M") == "09:29"
    assert float(first.iloc[-1]["close"]) == round(float(session_df.iloc[0]["open"]), 4)
    assert int(first["volume"].sum()) >= 1
    assert first[["open", "high", "low", "close", "volume"]].equals(second[["open", "high", "low", "close", "volume"]])


def test_synthetic_premarket_uses_normalized_price_scale():
    session_date = first_session_date()
    normalized_df = normalized_df_for_date(session_date)
    premarket = synthetic_premarket_candles(normalized_df, "SPY", session_date)

    assert 60 <= float(premarket.iloc[0]["open"]) <= 140
    assert float(premarket.iloc[-1]["close"]) == 100


def test_candle_endpoint_includes_synthetic_premarket_without_changing_replay():
    session_date = first_session_date()
    session_id = start_session({"assetClass": "Equity", "scenario": "Random", "practiceDate": session_date, "replaySpeed": "5x Speed"})
    candles_response = client.get(f"/api/sessions/{session_id}/candles?timeframe=1m")
    replay_response = client.get(f"/api/sessions/{session_id}/replay")

    assert candles_response.status_code == 200
    candles_payload = candles_response.json()
    assert candles_payload["premarketSource"] == "synthetic"
    assert len([candle for candle in candles_payload["candles"] if candle["sessionSegment"] == "pre_market"]) == 330
    assert len([candle for candle in candles_payload["candles"] if candle["sessionSegment"] == "regular"]) == 390
    assert len(replay_response.json()["ticks"]) == 4680


def test_missing_practice_date_returns_empty_match_error():
    response = client.post(
        "/api/sessions/start",
        json={"assetClass": "Equity", "scenario": "Random", "practiceDate": "1900-01-01", "timeframe": "1m", "startingCapital": 100000, "replaySpeed": "3x Speed"},
    )
    assert response.status_code == 404


def test_scorecard_reveals_spy_and_metrics():
    session_date = last_session_date("Equity")
    session_id = start_session({"assetClass": "Equity", "scenario": "Random", "practiceDate": session_date})
    replay = client.get(f"/api/sessions/{session_id}/replay").json()["ticks"]
    first_price = replay[0]["price"]
    score_response = client.post(
        f"/api/sessions/{session_id}/score",
        json={
            "startingCapital": 100000,
            "trades": [{"side": "buy", "quantity": 1000 / first_price, "price": first_price, "tickIndex": 0}],
        },
    )
    assert score_response.status_code == 200
    score = score_response.json()
    assert score["ticker"]
    assert score["date"] == "Hidden"
    assert score["hardcore"] is False
    assert "buyAndHoldReturnPct" in score
    assert "hiddenTags" in score
    assert isinstance(score["hiddenTags"], list)


def fixture_day(prices: list[float], volume: int = 1000) -> pd.DataFrame:
    timestamps = pd.date_range("2024-01-02 09:30", periods=len(prices), freq="1min")
    rows = []
    previous = prices[0]
    for timestamp, close in zip(timestamps, prices):
        open_price = previous
        high = max(open_price, close) + 0.02
        low = min(open_price, close) - 0.02
        rows.append({"timestamp": timestamp, "open": open_price, "high": high, "low": low, "close": close, "volume": volume, "symbol": "SPY"})
        previous = close
    return pd.DataFrame(rows)


def test_classifier_identifies_trend_chop_and_gap_fill():
    trend_prices = [100 + index * 0.03 for index in range(390)]
    chop_prices = [100 + (((index % 20) - 10) * 0.004) + (0.03 if (index // 10) % 2 == 0 else -0.03) for index in range(390)]
    gap_fill_prices = [102 - min(index * 0.01, 2.2) for index in range(390)]
    flush_prices = (
        [101 + (0.15 if index % 20 < 10 else -0.15) for index in range(180)]
        + [101 - index * 0.075 for index in range(60)]
        + [96.5 + index * 0.045 for index in range(100)]
        + [101 + (0.10 if index % 18 < 9 else -0.10) for index in range(50)]
    )
    previous = fixture_day([100 for _ in range(390)])

    trend_tags, _ = hidden_day_tags(fixture_day(trend_prices), previous)
    chop_tags, _ = hidden_day_tags(fixture_day(chop_prices), previous)
    gap_tags, _ = hidden_day_tags(fixture_day(gap_fill_prices), previous)
    flush_tags, _ = hidden_day_tags(fixture_day(flush_prices), previous)

    assert "trend_day" in trend_tags
    assert "chop_day" in chop_tags
    assert "gap_fill" in gap_tags
    assert "downside_flush" in flush_tags
    assert "chop_day" not in flush_tags
