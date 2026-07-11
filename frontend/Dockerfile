# Frontend: nginx serving the application (RollDesk) + reverse proxy to the API,
# with IP-based access restriction (ALLOWED_IPS).
FROM nginx:1.27-alpine

# Configuration as a template + entrypoint that builds the allowlist from ALLOWED_IPS
COPY nginx.conf.template /etc/nginx/conf.d/default.conf.template
COPY docker-entrypoint.sh /docker-entrypoint-allowlist.sh
RUN chmod +x /docker-entrypoint-allowlist.sh

# Application files
COPY app/ /usr/share/nginx/html/

EXPOSE 80
ENTRYPOINT ["/docker-entrypoint-allowlist.sh"]
