"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export default function Comments({ mint, wallet }) {
  // ---------- state ----------
  const [list, setList] = useState([]);        // newest first
  const [body, setBody] = useState("");
  const [tripEnabled, setTripEnabled] = useState(false);
  const [displayName, setDisplayName] = useState("Anonymous");

  // reply targets (numbers) shown as chips and mirrored at the start of textarea: ">>12 >>7 "
  const [replyNos, setReplyNos] = useState([]);

  const textRef = useRef(null);

  // ---------- local prefs (client only) ----------
  useEffect(() => {
    try {
      const t = localStorage.getItem("c_tripEnabled");
      if (t != null) setTripEnabled(t === "1");
      const nm = localStorage.getItem("c_displayName");
      if (nm) setDisplayName(nm);
    } catch {}
  }, []);

  useEffect(() => {
    try { localStorage.setItem("c_tripEnabled", tripEnabled ? "1" : "0"); } catch {}
  }, [tripEnabled]);

  useEffect(() => {
    try { localStorage.setItem("c_displayName", displayName || "Anonymous"); } catch {}
  }, [displayName]);

  // ---------- fetch initial ----------
  useEffect(() => {
    if (!mint) return;
    (async () => {
      try {
        const r = await fetch(`http://localhost:4000/comments?mint=${mint}`, { cache: "no-store" });
        const j = await r.json();
        setList(Array.isArray(j.comments) ? j.comments : []);
      } catch (e) {
        console.error("comments fetch failed", e);
      }
    })();
  }, [mint]);

  // ---------- SSE live comments ----------
  useEffect(() => {
    if (!mint) return;
    const es = new EventSource("http://localhost:4000/stream/holdings");
    const onComment = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg?.type !== "comment" || msg?.mint !== mint) return;
        setList((prev) => {
          if (prev.some((c) => (c.no ?? c.id) === (msg.no ?? msg.id))) return prev;
          return [msg, ...prev].slice(0, 500);
        });
      } catch {}
    };
    es.addEventListener("comment", onComment);
    return () => {
      es.removeEventListener("comment", onComment);
      es.close();
    };
  }, [mint]);

  // ---------- helpers ----------
  const fmtTs = (t) =>
    new Date(t).toLocaleString(undefined, {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });

  function renderBody(s) {
    if (!s) return null;

    // >>n links
    let html = s.replace(/&gt;&gt;(\d+)/g, (_m, num) => {
        const n = String(num);
        return `<a href="#c-${n}" style="color:#258; text-decoration:underline;">&gt;&gt;${n}</a>`;
    });

    // greentext: wrap lines starting with '>' (but not '>>')
    html = html
        .split("\n")
        .map((line) =>
        /^&gt;(?!&gt;)/.test(line)
            ? `<span class="greentext">${line}</span>`
            : line
        )
        .join("\n");

    return (
        <div
        style={{ whiteSpace: "pre-wrap", lineHeight: 1.35 }}
        dangerouslySetInnerHTML={{ __html: html }}
        />
    );
  }
  // Build the prefix ">>1 >>2 " from replyNos
  const replyPrefix = useMemo(
    () => (replyNos.length ? replyNos.map((n) => `>>${n}`).join(" ") + " " : ""),
    [replyNos]
  );

  // Keep reply chips and body prefix in sync when user manually edits the prefix
  function handleBodyChange(e) {
    const v = e.target.value;
    setBody(v);

    // Parse leading handles: ^(>>\d+\s+)+
    const m = v.match(/^((?:>>\d+\s*)+)/);
    if (m) {
      const nums = Array.from(m[1].matchAll(/>>(\d+)/g)).map((g) => Number(g[1]));
      const uniq = Array.from(new Set(nums));
      // only update if different (to avoid churn)
      if (uniq.join(",") !== replyNos.join(",")) setReplyNos(uniq);
    } else if (replyNos.length) {
      setReplyNos([]);
    }
  }

  // Add a reply handle (from a comment)
  function onClickReply(row) {
    const no = Number(row.no);
    if (!no || Number.isNaN(no)) return;

    setReplyNos((prev) => {
      if (prev.includes(no)) return prev; // already present

      const next = [...prev, no];
      const prefix = next.map((n) => `>>${n}`).join(" ") + " ";

      // inject prefix at start (replace old prefix if exists)
      const current = body;
      const stripped = current.replace(/^((?:>>\d+\s*)+)/, ""); // remove any existing handles
      const nextBody = prefix + stripped;
      setBody(nextBody);

      // move caret to end (start typing immediately after handles)
      requestAnimationFrame(() => {
        if (textRef.current) {
          const pos = nextBody.length;
          textRef.current.focus();
          textRef.current.setSelectionRange(pos, pos);
          textRef.current.scrollIntoView({ block: "nearest" });
        }
      });

      return next;
    });
  }

  // Remove a reply handle via chip
  function removeReplyNo(no) {
    setReplyNos((prev) => {
      const next = prev.filter((n) => n !== no);
      const newPrefix = next.length ? next.map((n) => `>>${n}`).join(" ") + " " : "";
      const stripped = body.replace(/^((?:>>\d+\s*)+)/, "");
      const nextBody = newPrefix + stripped;
      setBody(nextBody);
      // keep caret at start of text content (after prefix)
      requestAnimationFrame(() => {
        if (textRef.current) {
          const pos = newPrefix.length;
          textRef.current.focus();
          textRef.current.setSelectionRange(pos, pos);
        }
      });
      return next;
    });
  }

  // ---------- submit ----------
  async function submitComment() {
    const raw = body.replace(/\s+$/g, "");
    if (!raw) return;

    // author: Anonymous when trip disabled; custom allowed when trip enabled
    const authorToSend = tripEnabled ? (displayName || "Anonymous") : "Anonymous";

    let trip = "";
    if (tripEnabled && wallet) {
      try {
        const r = await fetch(`http://localhost:4000/tripcode?wallet=${wallet}`);
        const j = await r.json();
        if (j?.tripCode) trip = j.tripCode;
      } catch {}
    }

    try {
      const r = await fetch("http://localhost:4000/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mint,
          body: raw,
          author: authorToSend,
          trip: tripEnabled ? trip : "",
        }),
      });
      const j = await r.json();
      if (!r.ok || !j?.ok) throw new Error(j?.error || "failed");

      // optimistic insert
      setList((prev) => {
        const exists = prev.some((c) => (c.no ?? c.id) === (j.comment.no ?? j.comment.id));
        return exists ? prev : [j.comment, ...prev];
      });

      // clear composer (and reply state)
      setBody("");
      setReplyNos([]);
    } catch (e) {
      console.error("post comment failed", e);
    }
  }

  // ---------- UI ----------
  return (
    <section style={{ marginTop: "2rem", background: "#f6eae3", border: "1px solid #e5d2c7", borderRadius: 8, padding: 12 }}>
      <h3 style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 8px 0" }}>
        <span role="img" aria-label="bubbles">💬</span> Comments
      </h3>
      <hr style={{ border: 0, borderTop: "2px solid #b8796b", margin: "0 0 12px 0" }} />

      {/* Composer */}
      <div style={{ marginBottom: 12 }}>
        {/* Replying to chips */}
        {replyNos.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 13, color: "#555" }}>Replying to:</span>
            {replyNos.map((n) => (
              <span
                key={n}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: "#efe",
                  border: "1px solid #9c9",
                  fontFamily: "monospace",
                  fontSize: 13,
                }}
              >
                &gt;&gt;{n}
                <button
                  onClick={() => removeReplyNo(n)}
                  title="Remove"
                  style={{
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    lineHeight: 1,
                    padding: 0,
                    color: "#393",
                    fontWeight: 700,
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={textRef}
          rows={5}
          placeholder="Write a comment..."
          value={body}
          onChange={handleBodyChange}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: 12,
            borderRadius: 8,
            border: "1px solid #cdbab0",
            fontSize: 15,
            lineHeight: 1.35,
            outline: "none",
          }}
        />

        {/* Trip toggle + (conditional) custom display name */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }}>
            <input
              type="checkbox"
              checked={tripEnabled}
              onChange={(e) => setTripEnabled(e.target.checked)}
            />
            <span style={{ fontWeight: 700 }}>Post with wallet tripcode</span>
          </label>

          {tripEnabled && (
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value.slice(0, 32))}
              placeholder="Display name"
              style={{
                flex: 1,
                minWidth: 180,
                maxWidth: 320,
                boxSizing: "border-box",
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid #cdbab0",
                fontSize: 14,
              }}
            />
          )}
        </div>

        <button
          onClick={submitComment}
          style={{
            marginTop: 12,
            padding: "8px 16px",
            border: "1px solid #8aa",
            borderRadius: 8,
            background: "#eef2ff",
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          Submit
        </button>
      </div>
      {/* List (newest first) */}
        <div>
        {list.map((row) => (
            <div
            key={row.id ?? row.no}
            id={`c-${row.no ?? ""}`}
            className="post post--reply"
            >
            {/* (no thumb for replies, just body) */}
            <div className="post__body">
                {/* header line */}
                <div className="post__head">
                <span className="post__name" title={row.author || "Anonymous"}>
                    {row.author || "Anonymous"}
                </span>
                {row.trip && <span className="post__trip">!!{row.trip}</span>}
                <span className="post__meta">
                    No.{row.no ?? "?"} {fmtTs(row.ts)}
                </span>
                <button
                    onClick={() => onClickReply(row)}
                    title="Reply"
                    style={{
                    marginLeft: 10,
                    padding: "2px 8px",
                    border: "1px solid #9cb",
                    borderRadius: 6,
                    background: "#eef2ff",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    }}
                >
                    Reply
                </button>
                </div>

                {/* body with greentext */}
                <div className="post__text">
                {renderBody(row.body)}
                </div>
            </div>
            </div>
        ))}
        </div>

    </section>
  );
}
