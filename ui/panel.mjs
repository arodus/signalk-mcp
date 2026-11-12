import React, { useEffect, useState } from "react";
import {
  loadEditorConfiguration,
  saveConfiguration,
  catalogueGroups,
  approveRows,
  isWrite,
} from "./configuration.mjs";

const h = React.createElement;
const css = `
.mcp-config { color: inherit; font-size: 14px; container-type:inline-size; }
.mcp-config h3 { font-size: 20px; margin: 0; }
.mcp-config .mcp-toolbar { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; margin-bottom:8px; }
.mcp-config .mcp-help { color: #52606d; margin: 0 0 14px; line-height:1.5; }
.mcp-config .mcp-table-wrap { overflow-x:auto; border:1px solid #d8dee4; border-radius:6px; }
.mcp-config table { width:100%; border-collapse:collapse; min-width:590px; margin:0; }
.mcp-config th { background:#f5f7f9; color:#52606d; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
.mcp-config th, .mcp-config td { padding:10px 12px; border-bottom:1px solid #e5e9ed; vertical-align:middle; }
.mcp-config tr:last-child td { border-bottom:0; }
.mcp-config .mcp-group { background:#f5f7f9; overflow-wrap:anywhere; }
.mcp-config .mcp-group .mcp-toolbar { margin:0; }
.mcp-config .mcp-available, .mcp-config .mcp-manual { background:#eef4fa; color:#285680; }
.mcp-config .mcp-unsupported { background:#eee; color:#52606d; }
.mcp-config .mcp-operation { min-width:180px; overflow-wrap:anywhere; }
.mcp-config .mcp-operation strong, .mcp-config .mcp-operation small { display:block; }
.mcp-config .mcp-operation small { color:#52606d; margin-top:2px; }
.mcp-config .mcp-operation summary { cursor:pointer; font-size:12px; color:#52606d; margin-top:3px; }
.mcp-config .mcp-operation p { margin:6px 0 0; font-size:12px; }
.mcp-config .mcp-operation pre { max-width:520px; max-height:220px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; margin:6px 0; font-size:11px; }
.mcp-config .mcp-badge { display:inline-block; padding:3px 7px; border-radius:4px; font-size:12px; font-weight:600; white-space:nowrap; }
.mcp-config .mcp-approved { background:#e6f4ea; color:#1e6234; }
.mcp-config .mcp-pending { background:#fff2cc; color:#715400; }
.mcp-config .mcp-rejected { background:#fce8e6; color:#97332c; }
.mcp-config .mcp-actions { display:flex; gap:5px; flex-wrap:wrap; min-width:136px; }
.mcp-config button { font:inherit; }
.mcp-config .mcp-read { background:#eef4fa; color:#285680; }
.mcp-config .mcp-write { background:#fff2cc; color:#715400; }
.mcp-config .mcp-section { border-top:1px solid #d8dee4; padding-top:14px; margin-top:18px; }
.mcp-config .mcp-section > summary { cursor:pointer; font-weight:600; margin-bottom:12px; }
.mcp-config .mcp-fields { display:grid; grid-template-columns:minmax(0,2fr) minmax(0,1fr); gap:16px; }
.mcp-config label { display:block; margin-bottom:10px; }
.mcp-config label > span { display:block; margin-bottom:5px; }
.mcp-config input[type=text], .mcp-config input[type=number] { width:100%; padding:7px 9px; border:1px solid #c5ccd3; border-radius:4px; }
.mcp-config .mcp-manual { border:1px solid #d8dee4; padding:12px; border-radius:4px; margin-bottom:12px; }
.mcp-config .mcp-footer { display:flex; align-items:center; gap:12px; margin-top:18px; flex-wrap:wrap; }
.mcp-config .mcp-notice { margin-top:12px; padding:10px 12px; background:#eef4fa; border-radius:4px; }
.mcp-config .mcp-error { background:#fce8e6; color:#97332c; }
@container(max-width:640px) {
  .mcp-config table { min-width:0; }
  .mcp-config thead { display:none; }
  .mcp-config tbody { display:block; }
  .mcp-config tr { display:grid; grid-template-columns:minmax(0,1fr) auto; border-bottom:1px solid #e5e9ed; }
  .mcp-config tr:last-child { border-bottom:0; }
  .mcp-config td { min-width:0; border:0; padding:8px 12px; }
  .mcp-config td:first-child, .mcp-config td:last-child { grid-column:1/-1; }
  .mcp-config td:nth-child(2) { align-self:center; }
  .mcp-config td:nth-child(3) { justify-self:end; }
  .mcp-config .mcp-operation, .mcp-config .mcp-actions { min-width:0; }
  .mcp-config .mcp-actions { justify-content:flex-end; }
}
@media(max-width:600px) { .mcp-config .mcp-fields { grid-template-columns:1fr; gap:0; } }
`;
const status = {
  pending: "Pending request",
  available: "Not approved",
  manual: "Manual approval",
  unsupported: "Unsupported",
  approved: "Accepted",
  rejected: "Rejected",
};
const button = (text, onClick, props = {}) =>
  h(
    "button",
    {
      type: "button",
      className: "btn btn-sm btn-outline-secondary",
      onClick,
      ...props,
    },
    text,
  );

export default function Configuration() {
  const [base, setBase] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(null);
  const [groupFilter, setGroupFilter] = useState("");
  const dirty =
    base &&
    JSON.stringify({ reviews: base.reviews, settings: base.settings }) !==
      JSON.stringify(draft);
  const adopt = (next) => {
    setBase(next);
    setDraft({ reviews: next.reviews, settings: next.settings });
    setDeleting(null);
  };
  useEffect(() => {
    let mounted = true;
    loadEditorConfiguration()
      .then((next) => {
        if (mounted) adopt(next);
      })
      .catch(() => {
        if (mounted)
          setError(
            "Could not load settings. Sign in as an administrator and refresh.",
          );
      })
      .finally(() => {
        if (mounted) setBusy(false);
      });
    return () => {
      mounted = false;
    };
  }, []);
  async function refresh() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      adopt(await loadEditorConfiguration());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      adopt(await saveConfiguration(base, draft));
      setMessage("Configuration saved.");
      // The host hides Enable until configuration exists. Our native API save
      // does not update its cached plugin inventory, so refresh after setup.
      if (base.options.configuration == null) globalThis.location.reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  function stage(rows, decision = "approved") {
    setMessage("");
    setError("");
    try {
      const next = approveRows(draft, rows);
      if (decision !== "approved")
        for (const row of rows) next.reviews[row.key].decision = decision;
      setDraft(next);
    } catch (err) {
      setError(err.message);
    }
  }
  function setting(key, value) {
    setMessage("");
    setDraft((current) => ({
      ...current,
      settings: { ...current.settings, [key]: value },
    }));
  }
  function remove(key) {
    setDraft((current) => {
      const reviews = { ...current.reviews };
      delete reviews[key];
      return { ...current, reviews };
    });
    setDeleting(null);
    setMessage("");
  }
  function input(label, key, value, onChange, props = {}) {
    return h(
      "label",
      { key },
      h("span", null, label),
      h("input", {
        type: "text",
        value,
        disabled: busy,
        onChange: (event) => onChange(event.target.value),
        ...props,
      }),
    );
  }
  const groups = draft ? catalogueGroups(base, draft) : [];
  const rows = groups
    .filter((group) => !groupFilter || group.id === groupFilter)
    .flatMap((group) => [{ group }, ...group.rows]);
  const operationCount = groups.reduce(
    (count, group) => count + group.rows.length,
    0,
  );
  return h(
    "form",
    { className: "mcp-config", onSubmit: save },
    h("style", null, css),
    h(
      "div",
      { className: "mcp-toolbar" },
      h("h3", null, "Operation catalogue", base ? ` (${operationCount})` : ""),
      button("Refresh", refresh, {
        disabled: busy || Boolean(dirty),
        title: dirty
          ? "Save or discard your changes before refreshing"
          : "Discover current operations and requests",
      }),
    ),
    h(
      "p",
      { className: "mcp-help" },
      "Browse current plugin and native API operations. Approve reads or writes together for each plugin, or review them individually. All selections are staged until Save Configuration. New or changed operations need a new review; Signal K permissions still apply.",
    ),
    error
      ? h("div", { role: "alert", className: "mcp-notice mcp-error" }, error)
      : null,
    !base
      ? h(
          "p",
          { role: "status" },
          busy ? "Loading settings…" : "Settings unavailable.",
        )
      : h(
          React.Fragment,
          null,
          base.catalogueError
            ? h(
                "div",
                { role: "alert", className: "mcp-notice mcp-error" },
                base.catalogueError,
              )
            : null,
          h(
            "label",
            null,
            h("span", null, "Plugin or API"),
            h(
              "select",
              {
                value: groupFilter,
                "aria-label": "Plugin or API",
                disabled: busy,
                onChange: (event) => setGroupFilter(event.target.value),
                style: { maxWidth: "100%", padding: "7px 9px" },
              },
              h("option", { value: "" }, "All plugins and APIs"),
              ...groups.map((group) =>
                h("option", { key: group.id, value: group.id }, group.id),
              ),
            ),
          ),
          h(
            "p",
            { className: "mcp-help" },
            "Built-in data reads use Signal K permissions without approval. Native PUT and Resources writes appear below when requested: their exact source or provider must be identified. Up to 64 reviews can be saved; browsing does not use review slots.",
          ),
          h(
            "div",
            {
              className: "mcp-table-wrap",
              tabIndex: 0,
              role: "region",
              "aria-label": "Operation approvals",
            },
            h(
              "table",
              null,
              h(
                "thead",
                null,
                h(
                  "tr",
                  null,
                  ...["Operation", "Status", "Type", "Actions"].map((title) =>
                    h("th", { key: title, scope: "col" }, title),
                  ),
                ),
              ),
              h(
                "tbody",
                null,
                rows.length
                  ? rows.map((row) => {
                      if (row.group) {
                        const group = row.group;
                        const reads = group.rows.filter(
                          (row) =>
                            row.eligible &&
                            !isWrite(row.item) &&
                            row.status !== "approved",
                        );
                        const writes = group.rows.filter(
                          (row) =>
                            row.eligible &&
                            isWrite(row.item) &&
                            row.status !== "approved",
                        );
                        const label = group.id.startsWith("plugin.")
                          ? group.id.slice(7)
                          : group.id;
                        return h(
                          "tr",
                          { key: `group:${group.id}` },
                          h(
                            "td",
                            { colSpan: 4, className: "mcp-group" },
                            h(
                              "div",
                              { className: "mcp-toolbar" },
                              h("strong", null, label),
                              h(
                                "div",
                                { className: "mcp-actions" },
                                button(
                                  `Approve all current reads (${reads.length})`,
                                  () => stage(reads),
                                  {
                                    disabled: busy || !reads.length,
                                    "aria-label": `Approve all current reads for ${label}`,
                                  },
                                ),
                                button(
                                  `Approve all current writes (${writes.length})`,
                                  () => stage(writes),
                                  {
                                    disabled: busy || !writes.length,
                                    "aria-label": `Approve all current writes for ${label}`,
                                  },
                                ),
                              ),
                            ),
                            group.reason
                              ? h(
                                  "p",
                                  {
                                    className: "mcp-help",
                                    style: { margin: "8px 0 0" },
                                  },
                                  group.reason,
                                )
                              : null,
                            !group.rows.length && !group.reason
                              ? h("p", null, "No discoverable operations.")
                              : null,
                          ),
                        );
                      }
                      const { key, item } = row;
                      const put = item.kind === "put";
                      const post = item.kind === "post";
                      const plugin = item.kind === "plugin";
                      const resource = item.kind === "resource";
                      const api = item.kind === "api";
                      const write =
                        put ||
                        post ||
                        plugin ||
                        resource ||
                        (api && item.method !== "GET");
                      const absent =
                        !put &&
                        !resource &&
                        !api &&
                        !base.installed.includes(item.pluginId);
                      const label = resource
                        ? `${item.method} ${item.collection} provider ${item.provider}`
                        : put
                          ? `PUT ${item.context}:${item.path} source ${item.source}`
                          : `${api ? item.api : item.pluginId}: ${item.operationId}`;
                      const description = put
                        ? item.metadata.description
                        : item.description;
                      return h(
                        "tr",
                        { key },
                        h(
                          "td",
                          { className: "mcp-operation" },
                          h(
                            "strong",
                            null,
                            resource
                              ? `${item.method} ${item.collection}`
                              : put
                                ? item.path
                                : item.operationId,
                          ),
                          h(
                            "small",
                            null,
                            resource
                              ? `Resources · ${item.provider}`
                              : put
                                ? `Native PUT · ${item.context}`
                                : api
                                  ? `Native API ${item.method} · ${item.api}`
                                  : `Plugin ${post || plugin ? item.method : "GET"} · ${item.pluginId}`,
                            absent ? " · Not installed" : "",
                          ),
                          put
                            ? h("small", null, `Source: ${item.source}`)
                            : null,
                          h(
                            "details",
                            null,
                            h(
                              "summary",
                              null,
                              put
                                ? "Meaning and value constraints"
                                : `${resource || post || plugin || api ? item.method : "GET"} ${item.path}`,
                            ),
                            h(
                              "p",
                              null,
                              typeof description === "string" && description
                                ? description
                                : "No description provided.",
                            ),
                            item.inputSchema || row.operation?.inputSchema
                              ? h(
                                  React.Fragment,
                                  null,
                                  put
                                    ? h("p", null, "Provider metadata")
                                    : null,
                                  h(
                                    "pre",
                                    null,
                                    JSON.stringify(
                                      put
                                        ? item.metadata
                                        : {
                                            method: item.method,
                                            path: item.path,
                                            ...(resource
                                              ? { provider: item.provider }
                                              : {}),
                                          },
                                      null,
                                      2,
                                    ),
                                  ),
                                  h(
                                    "p",
                                    null,
                                    resource && item.method === "DELETE"
                                      ? "Accepted target schema"
                                      : post || plugin || resource || api
                                        ? "Accepted input schema (body is sent as JSON)"
                                        : "Accepted value schema",
                                  ),
                                  h(
                                    "pre",
                                    null,
                                    JSON.stringify(
                                      item.inputSchema ??
                                        row.operation?.inputSchema,
                                      null,
                                      2,
                                    ),
                                  ),
                                )
                              : null,
                            h(
                              "p",
                              null,
                              put
                                ? "Accept only this exact path and source after checking what it controls. Metadata and schema changes require a new review."
                                : resource
                                  ? "Approval applies to this method, collection and provider. Changes to the input schema or meaning require a new review."
                                  : post || plugin || api
                                    ? "Approval applies to this exact method and route. Changes to the input schema or meaning require a new review. Check the provider's side effects and data permissions."
                                    : "Check the provider's implementation for side effects and data permissions.",
                            ),
                          ),
                        ),
                        h(
                          "td",
                          null,
                          h(
                            "span",
                            { className: `mcp-badge mcp-${row.status}` },
                            status[row.status],
                          ),
                          row.reason || (!row.eligible && row.operation?.reason)
                            ? h(
                                "small",
                                {
                                  style: {
                                    display: "block",
                                    overflowWrap: "anywhere",
                                  },
                                },
                                row.reason || row.operation.reason,
                              )
                            : null,
                        ),
                        h(
                          "td",
                          null,
                          h(
                            "span",
                            {
                              className: `mcp-badge mcp-${write ? "write" : "read"}`,
                              title: put
                                ? "Requires native Signal K PUT permission"
                                : write
                                  ? "Requires a write-capable Signal K identity and provider permission"
                                  : "Requires native Signal K read permission",
                            },
                            write ? "Write" : "Read",
                          ),
                        ),
                        h(
                          "td",
                          null,
                          h(
                            "div",
                            { className: "mcp-actions" },
                            button("Accept", () => stage([row]), {
                              disabled:
                                busy ||
                                absent ||
                                !row.eligible ||
                                item.decision === "approved",
                              "aria-label": `Accept ${label}`,
                            }),
                            button(
                              "Reject",
                              () =>
                                stage([{ ...row, eligible: true }], "rejected"),
                              {
                                disabled:
                                  busy ||
                                  (!row.eligible && !draft.reviews[key]) ||
                                  item.decision === "rejected",
                                "aria-label": `Reject ${label}`,
                              },
                            ),
                            draft.reviews[key] &&
                              (write || api || absent) &&
                              deleting !== key
                              ? button("Delete", () => setDeleting(key), {
                                  disabled: busy,
                                  "aria-label": `Delete ${label}`,
                                })
                              : null,
                            deleting === key
                              ? h(
                                  "div",
                                  null,
                                  h(
                                    "small",
                                    null,
                                    write || api
                                      ? "Remove this review and revoke its approval when you save? A later request will need a new review."
                                      : "Remove this saved review?",
                                  ),
                                  h(
                                    "div",
                                    { className: "mcp-actions" },
                                    button("Delete row", () => remove(key), {
                                      disabled: busy,
                                      className: "btn btn-sm btn-danger",
                                    }),
                                    button("Cancel", () => setDeleting(null), {
                                      disabled: busy,
                                    }),
                                  ),
                                )
                              : null,
                          ),
                        ),
                      );
                    })
                  : h(
                      "tr",
                      null,
                      h(
                        "td",
                        { colSpan: 4 },
                        "No discoverable operations or pending requests. Refresh after enabling a plugin with OpenAPI documentation.",
                      ),
                    ),
              ),
            ),
          ),
          h(
            "p",
            {
              className: "mcp-help",
              style: { marginTop: 10, marginBottom: 0 },
            },
            "Rejected requests stay in this list. Delete a write or native API review to revoke its approval; plugin GET reviews can be deleted when the plugin is no longer installed. Save to apply changes.",
          ),
          h(
            "details",
            { className: "mcp-section" },
            h("summary", null, "Connection and data settings"),
            h(
              "div",
              { className: "mcp-fields" },
              input(
                "HTTPS certificate hostname (optional)",
                "tls",
                draft.settings.localTlsServerName,
                (value) => setting("localTlsServerName", value),
                { maxLength: 253 },
              ),
              input(
                "Stale after (seconds)",
                "stale",
                draft.settings.staleAfterSeconds,
                (value) =>
                  setting(
                    "staleAfterSeconds",
                    value === "" ? "" : Number(value),
                  ),
                { type: "number", min: 1, max: 86400, step: 1, required: true },
              ),
            ),
            h(
              "p",
              { className: "mcp-help" },
              "Certificate hostname: used to verify requests back to Signal K when Signal K serves HTTPS. Enter the hostname on its certificate, such as boat.example, if it does not cover the local IP. Leave blank for HTTP or a reverse proxy. No scheme, port or certificate file path.",
            ),
            h(
              "p",
              { className: "mcp-help" },
              "Stale after marks older measurements as stale. Values are forwarded unchanged.",
            ),
          ),
          h(
            "details",
            { className: "mcp-section" },
            h(
              "summary",
              null,
              `Manual approvals (advanced) · ${draft.settings.pluginOperations.length}`,
            ),
            h(
              "p",
              { className: "mcp-help" },
              "Existing manual approvals are preserved. Use the catalogue above for new reviews. A matching rejection overrides a manual approval.",
            ),
            ...draft.settings.pluginOperations.map((item, index) => {
              const update = (changes) =>
                setting(
                  "pluginOperations",
                  draft.settings.pluginOperations.map((entry, i) =>
                    i === index ? { ...entry, ...changes } : entry,
                  ),
                );
              return h(
                "div",
                { className: "mcp-manual", key: index },
                h(
                  "div",
                  { className: "mcp-fields" },
                  ...[
                    ["Plugin ID", "pluginId"],
                    ["Operation ID", "operationId"],
                    ["GET endpoint path", "path"],
                  ].map(([label, field]) =>
                    input(
                      label,
                      field,
                      item[field] ?? "",
                      (value) => update({ [field]: value }),
                      { required: true },
                    ),
                  ),
                ),
                h(
                  "label",
                  null,
                  h("input", {
                    type: "checkbox",
                    checked: item.readOnly === true,
                    disabled: busy,
                    required: true,
                    onChange: (event) =>
                      update({ readOnly: event.target.checked }),
                  }),
                  " Confirmed read-only",
                ),
                h("span", { className: "mcp-badge mcp-read" }, "Read"),
                " ",
                button(
                  "Remove manual approval",
                  () =>
                    setting(
                      "pluginOperations",
                      draft.settings.pluginOperations.filter(
                        (_, i) => i !== index,
                      ),
                    ),
                  { disabled: busy },
                ),
              );
            }),
            button(
              "Add manual approval",
              () =>
                setting("pluginOperations", [
                  ...draft.settings.pluginOperations,
                  {
                    pluginId: "",
                    operationId: "",
                    path: "",
                    method: "GET",
                    readOnly: false,
                    permission: "readonly",
                  },
                ]),
              {
                disabled: busy || draft.settings.pluginOperations.length >= 64,
              },
            ),
          ),
          h(
            "div",
            { className: "mcp-footer" },
            h(
              "button",
              {
                type: "submit",
                className: "btn btn-primary",
                disabled: busy,
              },
              busy ? "Saving…" : "Save Configuration",
            ),
            dirty
              ? button(
                  "Discard changes",
                  () => {
                    adopt(base);
                    setError("");
                    setMessage("");
                  },
                  { disabled: busy },
                )
              : null,
            h("span", { role: "status" }, dirty ? "Unsaved changes" : message),
          ),
        ),
  );
}
