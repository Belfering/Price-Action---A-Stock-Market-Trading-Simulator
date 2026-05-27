from fastapi.testclient import TestClient

from backend.main import allocate_volume_deltas, app


client = TestClient(app)


def start_session(payload=None):
    response = client.post(
        "/api/sessions/start",
        json=payload
        or {
            "assetClass": "Random",
            "scenario": "Random",
            "timeframe": "1m",
            "startingCapital": 25000,
            "replaySpeed": "Normal",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["sessionId"]


def test_health_loads_two_day_spy_dataset():
    response = client.get("/api/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["rows"] == 780
    assert payload["ticker"] == "SPY"
    assert payload["dates"] == ["2026-05-22", "2026-05-26"]


def test_replay_tick_count_is_eight_ticks_per_minute():
    session_id = start_session({"assetClass": "Equity", "scenario": "Random", "practiceDate": "2026-05-22"})
    response = client.get(f"/api/sessions/{session_id}/replay")
    assert response.status_code == 200
    ticks = response.json()["ticks"]
    assert len(ticks) == 3120
    assert ticks[0]["phase"] == "open"
    assert ticks[7]["phase"] == "close"


def test_intracandle_path_has_anchors_random_ticks_and_volume_build():
    session_id = start_session({"assetClass": "Equity", "scenario": "Random", "practiceDate": "2026-05-22"})
    ticks = client.get(f"/api/sessions/{session_id}/replay").json()["ticks"]
    first_candle = ticks[:8]
    phases = [tick["phase"] for tick in first_candle]

    assert phases.count("open") == 1
    assert phases.count("high") == 1
    assert phases.count("low") == 1
    assert phases.count("close") == 1
    assert phases.count("random") == 4
    assert abs(phases.index("high") - phases.index("low")) > 1

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
    session_id = start_session({"assetClass": "Equity", "scenario": "Random", "practiceDate": "2026-05-22"})
    response = client.get(f"/api/sessions/{session_id}/candles?timeframe=5m")
    assert response.status_code == 200
    candles = response.json()["candles"]
    assert len(candles) == 78
    assert candles[0]["timestamp"].startswith("2026-05-22T09:30:00")


def test_unsupported_filter_returns_empty_match_error():
    response = client.post(
        "/api/sessions/start",
        json={"assetClass": "Bond", "scenario": "Random", "timeframe": "1m", "startingCapital": 25000, "replaySpeed": "Normal"},
    )
    assert response.status_code == 404


def test_scorecard_reveals_spy_and_metrics():
    session_id = start_session({"assetClass": "Equity", "scenario": "Random", "practiceDate": "2026-05-26"})
    replay = client.get(f"/api/sessions/{session_id}/replay").json()["ticks"]
    first_price = replay[0]["price"]
    score_response = client.post(
        f"/api/sessions/{session_id}/score",
        json={
            "startingCapital": 25000,
            "trades": [{"side": "buy", "quantity": 1000 / first_price, "price": first_price, "tickIndex": 0}],
        },
    )
    assert score_response.status_code == 200
    score = score_response.json()
    assert score["ticker"] == "SPY"
    assert score["date"] == "2026-05-26"
    assert "buyAndHoldReturnPct" in score
