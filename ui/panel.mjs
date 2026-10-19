import React, { useEffect, useState } from "react";
import { loadConfiguration, saveConfiguration } from "./configuration.mjs";

const h = React.createElement;
const css = `
.mcp-config { color: inherit; font-size: 14px; }
.mcp-config h3 { font-size: 20px; margin: 0; }
.mcp-config .mcp-toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:8px; }
.mcp-config .mcp-help { color: #52606d; margin: 0 0 14px; line-height:1.5; }
.mcp-config .mcp-table-wrap { overflow-x:auto; border:1px solid #d8dee4; border-radius:6px; }
.mcp-config table { width:100%; border-collapse:collapse; min-width:590px; margin:0; }
.mcp-config th { background:#f5f7f9; color:#52606d; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
.mcp-config th, .mcp-config td { padding:10px 12px; border-bottom:1px solid #e5e9ed; vertical-align:middle; }
.mcp-config tr:last-child td { border-bottom:0; }
.mcp-config .mcp-operation { min-width:180px; overflow-wrap:anywhere; }
.mcp-config .mcp-operation strong, .mcp-config .mcp-operation small { display:block; }
.mcp-config .mcp-operation small { color:#52606d; margin-top:2px; }
.mcp-config .mcp-operation summary { cursor:pointer; font-size:12px; color:#52606d; margin-top:3px; }
.mcp-config .mcp-operation p { margin:6px 0 0; font-size:12px; }
.mcp-config .mcp-badge { display:inline-block; padding:3px 7px; border-radius:4px; font-size:12px; font-weight:600; white-space:nowrap; }
.mcp-config .mcp-approved { background:#e6f4ea; color:#1e6234; }
.mcp-config .mcp-pending { background:#fff2cc; color:#715400; }
.mcp-config .mcp-rejected { background:#fce8e6; color:#97332c; }
.mcp-config .mcp-actions { display:flex; gap:5px; flex-wrap:wrap; min-width:136px; }
.mcp-config button, .mcp-config select { font:inherit; }
.mcp-config .mcp-access { min-width:94px; padding:5px; border:1px solid #c5ccd3; border-radius:4px; background:white; color:#27333e; }
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
@media(max-width:600px) { .mcp-config .mcp-fields { grid-template-columns:1fr; gap:0; } }
`;
const status = {
  pending: "Pending",
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
    loadConfiguration()
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
      adopt(await loadConfiguration());
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
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  function review(key, changes) {
    setMessage("");
    setDraft((value) => ({
      ...value,
      reviews: {
        ...value.reviews,
        [key]: { ...value.reviews[key], ...changes },
      },
    }));
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
  function access(value, onChange, label) {
    return h(
      "select",
      {
        className: "mcp-access",
        "aria-label": label,
        value,
        disabled: busy,
        onChange: (event) => onChange(event.target.value),
      },
      h("option", { value: "readonly" }, "Readers"),
      h("option", { value: "admin" }, "Admins only"),
    );
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
  const rows = draft ? Object.entries(draft.reviews) : [];
  return h(
    "form",
    { className: "mcp-config", onSubmit: save },
    h("style", null, css),
    h(
      "div",
      { className: "mcp-toolbar" },
      h("h3", null, "Plugin read requests", base ? ` (${rows.length})` : ""),
      button("Refresh", refresh, {
        disabled: busy || Boolean(dirty),
        title: dirty
          ? "Save or discard your changes before refreshing"
          : "Fetch new requests",
      }),
    ),
    h(
      "p",
      { className: "mcp-help" },
      "Review each read before accepting it. Signal K permissions still apply. Changes take effect when you save.",
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
          h(
            "div",
            {
              className: "mcp-table-wrap",
              tabIndex: 0,
              role: "region",
              "aria-label": "Plugin read approvals",
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
                  ...["Operation", "Status", "Access", "Actions"].map((title) =>
                    h("th", { key: title, scope: "col" }, title),
                  ),
                ),
              ),
              h(
                "tbody",
                null,
                rows.length
                  ? rows.map(([key, item]) => {
                      const absent = !base.installed.includes(item.pluginId);
                      const label = `${item.pluginId}: ${item.operationId}`;
                      return h(
                        "tr",
                        { key },
                        h(
                          "td",
                          { className: "mcp-operation" },
                          h("strong", null, item.operationId),
                          h(
                            "small",
                            null,
                            item.pluginId,
                            absent ? " · Not installed" : "",
                          ),
                          h(
                            "details",
                            null,
                            h("summary", null, `GET ${item.path}`),
                            h(
                              "p",
                              null,
                              item.description || "No description provided.",
                            ),
                            h(
                              "p",
                              null,
                              "Check the provider's implementation for side effects and data permissions.",
                            ),
                          ),
                        ),
                        h(
                          "td",
                          null,
                          h(
                            "span",
                            { className: `mcp-badge mcp-${item.decision}` },
                            status[item.decision],
                          ),
                        ),
                        h(
                          "td",
                          null,
                          access(
                            item.permission,
                            (value) => review(key, { permission: value }),
                            `Access for ${label}`,
                          ),
                        ),
                        h(
                          "td",
                          null,
                          h(
                            "div",
                            { className: "mcp-actions" },
                            button(
                              "Accept",
                              () => review(key, { decision: "approved" }),
                              {
                                disabled:
                                  busy ||
                                  absent ||
                                  item.decision === "approved",
                                "aria-label": `Accept ${label}`,
                              },
                            ),
                            button(
                              "Reject",
                              () => review(key, { decision: "rejected" }),
                              {
                                disabled: busy || item.decision === "rejected",
                                "aria-label": `Reject ${label}`,
                              },
                            ),
                            absent && deleting !== key
                              ? button("Delete", () => setDeleting(key), {
                                  disabled: busy,
                                  "aria-label": `Delete ${label}`,
                                })
                              : null,
                            deleting === key
                              ? h(
                                  "div",
                                  null,
                                  h("small", null, "Remove this saved review?"),
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
                        "No requests yet. Refresh after a client attempts an unapproved plugin read.",
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
            "Rejected requests stay in this list. Delete is available for plugins that are no longer installed.",
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
              "Existing manual approvals are preserved. Use requests above for new reviews. A matching rejection overrides a manual approval.",
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
                access(
                  item.permission ?? "readonly",
                  (value) => update({ permission: value }),
                  `Access for manual approval ${index + 1}`,
                ),
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
                disabled: busy || !dirty,
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
