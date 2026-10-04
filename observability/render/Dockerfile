# One container with Grafana, Prometheus and Loki behind a small nginx, for a single free Render web service.
# Render exposes one port, so nginx owns it: it serves Grafana, and lets the app push logs to Loki with a bearer token.
# Prometheus and Loki listen on localhost only. Build context is the repository root.
FROM prom/prometheus:v3.5.0 AS prometheus
FROM grafana/loki:3.5.0 AS loki

FROM grafana/grafana:12.1.0
USER root
RUN apk add --no-cache nginx gettext su-exec
COPY --from=prometheus /bin/prometheus /usr/local/bin/prometheus
COPY --from=loki /usr/bin/loki /usr/local/bin/loki
COPY observability/render/start.sh /start.sh
COPY observability/render/nginx.conf.template observability/render/prometheus.yml.template observability/render/loki-config.yml /etc/monitoring/
COPY observability/render/provisioning /etc/grafana/provisioning
COPY observability/grafana/dashboards /var/lib/grafana/dashboards
RUN chmod +x /start.sh && chown -R grafana:root /var/lib/grafana /etc/grafana/provisioning
ENV GF_PATHS_PROVISIONING=/etc/grafana/provisioning \
    GF_SERVER_HTTP_ADDR=127.0.0.1 \
    GF_SERVER_HTTP_PORT=3000 \
    GF_USERS_ALLOW_SIGN_UP=false \
    GF_ANALYTICS_REPORTING_ENABLED=false \
    GF_ANALYTICS_CHECK_FOR_UPDATES=false \
    GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH=/var/lib/grafana/dashboards/seat-reservation.json \
    GOMEMLIMIT=120MiB
ENTRYPOINT ["/start.sh"]
