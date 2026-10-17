# A sandbox bench: the official ERPNext image plus the customer's apps (apps/tbo-sandbox/README.md).
# The runner builds it on the fix server with a context holding apps/<app> for each custom app.
ARG BASE=frappe/erpnext:v15.122.0
FROM ${BASE}

USER frappe
WORKDIR /home/frappe/frappe-bench
COPY --chown=frappe:frappe apps/ /tmp/tbo-apps/
COPY --chown=frappe:frappe tbo_sandbox_site.py /tmp/tbo_sandbox_site.py
# Each app goes in as Frappe installs one (an editable install, listed in sites/apps.txt, which
# the official image ends without a newline);
# the helper module the runner calls with `bench execute` goes next to the bench's packages.
RUN set -e; \
    [ -z "$(tail -c1 sites/apps.txt)" ] || echo >> sites/apps.txt; \
    for path in /tmp/tbo-apps/*/; do \
        [ -d "$path" ] || continue; \
        app=$(basename "$path"); \
        mv "$path" "apps/$app"; \
        env/bin/pip install --quiet --no-cache-dir -e "apps/$app"; \
        grep -qx "$app" sites/apps.txt || echo "$app" >> sites/apps.txt; \
    done; \
    cp /tmp/tbo_sandbox_site.py "$(env/bin/python -c 'import site; print(site.getsitepackages()[0])')/"; \
    rm -rf /tmp/tbo-apps /tmp/tbo_sandbox_site.py
