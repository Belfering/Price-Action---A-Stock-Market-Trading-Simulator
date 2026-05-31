tradingsimulator.io, www.tradingsimulator.io {
    encode gzip zstd

    header {
        X-Frame-Options "DENY"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "same-origin"
        Permissions-Policy "geolocation=(), microphone=(), camera=()"
    }

    reverse_proxy 127.0.0.1:8080
}
