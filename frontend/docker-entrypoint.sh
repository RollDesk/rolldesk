#!/bin/sh
set -e

TEMPLATE=/etc/nginx/conf.d/default.conf.template
TARGET=/etc/nginx/conf.d/default.conf

# Build the "allow" rules block from the ALLOWED_IPS list (commas or spaces).
ALLOW_BLOCK=""
if [ -n "$ALLOWED_IPS" ]; then
  # replace commas with spaces, iterate
  for ip in $(echo "$ALLOWED_IPS" | tr ',' ' '); do
    ip_trimmed=$(echo "$ip" | xargs)
    if [ -n "$ip_trimmed" ]; then
      ALLOW_BLOCK="${ALLOW_BLOCK}    allow ${ip_trimmed};\n"
    fi
  done
  echo "[entrypoint] IP access restriction: $ALLOWED_IPS"
else
  # Empty list = no restriction (for testing only!)
  ALLOW_BLOCK="    allow all;\n"
  echo "[entrypoint] WARNING: ALLOWED_IPS is empty — access from any IP address."
fi

# Insert the block in place of the #ALLOWLIST# marker
awk -v block="$ALLOW_BLOCK" '
  /#ALLOWLIST#/ { printf block; next }
  { print }
' "$TEMPLATE" > "$TARGET"

exec nginx -g "daemon off;"
