"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useWallet as useAdapterWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";

const PAGE_SIZE = 50; 

export default function Comments({ mint, wallet: walletProp }) {
  // ---------- wallet (context-first) ----------
  const { publicKey } = useAdapterWallet();
  const { setVisible: setWalletModalVisible } = useWalletModal();

  const walletStr = publicKey ? publicKey.toBase58() : (walletProp || "");
  const canComment = !!walletStr;

  function handleConnectWallet() {
    setWalletModalVisible(true); // opens the adapter’s modal
  }

  // ---------- state ----------
  const [list, setList] = useState([]); // newest first (as before)
  const [body, setBody] = useState("");
  const [tripEnabled, setTripEnabled] = useState(false);
  const [displayName, setDisplayName] = useState("");

  // reply targets (numbers) shown as chips and mirrored at the start of textarea: ">>12 >>7 "
  const [replyNos, setReplyNos] = useState([]);

  // paging
  const [currentPage, setCurrentPage] = useState(1); // 1-based
  const [stickToLast, setStickToLast] = useState(true);

  const textRef = useRef(null);
  const didInitRef = useRef(false);

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
    try { localStorage.setItem("c_displayName", displayName || null); } catch {}
  }, [displayName]);

  // ---------- fetch initial ----------
  useEffect(() => {
    if (!mint) return;
    (async () => {
      try {
        const r = await fetch(`http://localhost:4000/comments?mint=${mint}`, { cache: "no-store" });
        const j = await r.json();
        const arr = Array.isArray(j.comments) ? j.comments : [];
        setList(arr);
        didInitRef.current = true;
      } catch (e) {
        console.error("comments fetch failed", e);
      }
    })();
  }, [mint]);

  useEffect(() => {
    if (!mint) return;
    const h = (e) => {
      const msg = e.detail;
      if (!msg || msg.mint !== mint) return;
      setList((prev) => {
        const key = msg.no ?? msg.id;
        if (key != null && prev.some((c) => (c.no ?? c.id) === key)) return prev;
        return [msg, ...prev].slice(0, 500);
      });
    };
    window.addEventListener("live-comment", h);
    return () => window.removeEventListener("live-comment", h);
  }, [mint]);

  // ---------- paging derived state ----------
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));

  useEffect(() => {
    if (!didInitRef.current || stickToLast) {
      setCurrentPage(totalPages);
    } else {
      setCurrentPage((p) => Math.min(Math.max(1, p), totalPages));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.length, totalPages]);

  const pageItems = useMemo(() => {
    const chrono = [...list].reverse(); // oldest -> newest
    const start = (currentPage - 1) * PAGE_SIZE;
    const end = currentPage * PAGE_SIZE;
    const slice = chrono.slice(start, end);
    return slice.reverse(); // render newest-first inside the page
  }, [list, currentPage]);

  function goToPage(p) {
    const np = Math.min(Math.max(1, p), totalPages);
    setStickToLast(np === totalPages);
    setCurrentPage(np);
  }
  function nextPage() { goToPage(currentPage + 1); }
  function prevPage() { goToPage(currentPage - 1); }

  useEffect(() => {
    if (currentPage !== totalPages) setStickToLast(false);
  }, [currentPage, totalPages]);

  // ---------- helpers ----------
  const fmtTs = (t) =>
    new Date(t).toLocaleString(undefined, {
      year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "2-digit", second: "2-digit",
    });

  function renderBody(s) {
    if (!s) return null;

    // >>n links
    let html = s.replace(/&gt;&gt;(\d+)/g, (_m, num) => {
      const n = String(num);
      return `<a href="#c-${n}" style="color:#258; text-decoration:underline;">&gt;&gt;${n}</a>`;
    });

    // greentext: '>' but not '>>'
    html = html
      .split("\n")
      .map((line) => (/^&gt;(?!&gt;)/.test(line) ? `<span class="greentext">${line}</span>` : line))
      .join("\n");

    return <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.35 }} dangerouslySetInnerHTML={{ __html: html }} />;
  }

  function handleBodyChange(e) {
    const v = e.target.value;
    setBody(v);

    const m = v.match(/^((?:>>\d+\s*)+)/);
    if (m) {
      const nums = Array.from(m[1].matchAll(/>>(\d+)/g)).map((g) => Number(g[1]));
      const uniq = Array.from(new Set(nums));
      if (uniq.join(",") !== replyNos.join(",")) setReplyNos(uniq);
    } else if (replyNos.length) {
      setReplyNos([]);
    }
  }

  function onClickReply(row) {
    const no = Number(row.no);
    if (!no || Number.isNaN(no)) return;

    setReplyNos((prev) => {
      if (prev.includes(no)) return prev;

      const next = [...prev, no];
      const prefix = next.map((n) => `>>${n}`).join(" ") + " ";

      const current = body;
      const stripped = current.replace(/^((?:>>\d+\s*)+)/, "");
      const nextBody = prefix + stripped;
      setBody(nextBody);

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

  function removeReplyNo(no) {
    setReplyNos((prev) => {
      const next = prev.filter((n) => n !== no);
      const newPrefix = next.length ? next.map((n) => `>>${n}`).join(" ") + " " : "";
      const stripped = body.replace(/^((?:>>\d+\s*)+)/, "");
      const nextBody = newPrefix + stripped;
      setBody(nextBody);
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
    if (!canComment) return;
    const raw = body.replace(/\s+$/g, "");
    if (!raw) return;

    let authorToSend = "";
    let trip = "";

    if (tripEnabled) {
      authorToSend = displayName.trim(); // may be ""
      if (walletStr) {
        try {
          const r = await fetch(`http://localhost:4000/tripcode?wallet=${walletStr}`);
          const j = await r.json();
          if (j?.tripCode) trip = j.tripCode;
        } catch {}
      }
    } else {
      // trip disabled → force Anonymous
      authorToSend = "Anonymous";
    }

    try {
      const payload = { mint, body: raw, trip };
      if (authorToSend) payload.author = authorToSend;

      const r = await fetch("http://localhost:4000/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok || !j?.ok) throw new Error(j?.error || "failed");

      setList((prev) => {
        const key = j.comment?.no ?? j.comment?.id;
        if (key == null) return [j.comment, ...prev]; // insert if server didn't return an id yet
        const exists = prev.some((c) => (c.no ?? c.id) === key);
        return exists ? prev : [j.comment, ...prev];
      });


      setBody("");
      setReplyNos([]);
      setStickToLast(true);
    } catch (e) {
      console.error("post comment failed", e);
    }
  }

  // ---------- pagination UI helpers ----------
  function buildPageModel(total, current) {
    const out = [];
    if (total <= 10) {
      for (let i = 1; i <= total; i++) out.push(i);
      return out;
    }
    const first = [1, 2];
    const last = [total - 1, total];
    const around = [current - 1, current, current + 1].filter((n) => n > 2 && n < total - 1);

    const pushWithGap = (arr, n) => {
      if (arr.length && typeof arr[arr.length - 1] === "number" && n - arr[arr.length - 1] > 1) arr.push("...");
      arr.push(n);
    };

    const seq = [];
    first.forEach((n) => pushWithGap(seq, n));
    around.forEach((n) => pushWithGap(seq, n));
    last.forEach((n) => pushWithGap(seq, n));

    return seq;
  }

  const pageModel = useMemo(() => buildPageModel(totalPages, currentPage), [totalPages, currentPage]);

  // ---------- UI ----------
  return (
    <section style={{ marginTop: "2rem", background: "#f6eae3", border: "1px solid #e5d2c7", borderRadius: 8, padding: 12 }}>
      <h3 style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 8px 0" }}>
        <span role="img" aria-label="bubbles">💬</span> Comments
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#666" }}>
          Page {currentPage} / {totalPages} • {list.length} total
        </span>
      </h3>
      <hr style={{ border: 0, borderTop: "2px solid #b8796b", margin: "0 0 12px 0" }} />

      {/* Composer */}
      {!canComment ? (
        <div
          style={{
            marginBottom: 12,
            padding: 12,
            borderRadius: 8,
            border: "1px dashed #cdbab0",
            background: "#fff8f3",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ fontSize: 14 }}>
            You need to connect your wallet to post comments.
          </div>
          <a
            href="#"
            onClick={(e) => { e.preventDefault(); handleConnectWallet(); }}
            className="chan-link"
            style={{
              display: "inline-block",
              padding: 0,
              border: "none",
              background: "transparent",
              outline: "none",
              boxShadow: "none",
              fontWeight: 600,
            }}
          >
            [Connect Wallet]
          </a>

        </div>
      ) : (
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
              <input type="checkbox" checked={tripEnabled} onChange={(e) => setTripEnabled(e.target.checked)} />
              <span style={{ fontWeight: 700 }}>Post with wallet tripcode</span>
            </label>

            {tripEnabled && (
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value.slice(0, 32))}
                placeholder="Display name"
                style={{ flex: 1, minWidth: 180, maxWidth: 320, boxSizing: "border-box", padding: "8px 10px", borderRadius: 8, border: "1px solid #cdbab0", fontSize: 14 }}
              />
            )}
          </div>

        <button
          type="button"
          onClick={submitComment}
          className="chan-link"
          style={{
            marginTop: 12,
            padding: 0,
            border: "none",
            background: "transparent",
            outline: "none",
            boxShadow: "none",
            fontWeight: 600,
          }}
        >
          [Submit Comment]
        </button>

        </div>
      )}

      {/* List (newest-first inside the current page) */}
      <div>
        {pageItems.map((row) => (
          <div key={row.id ?? row.no} id={`c-${row.no ?? ""}`} className="post post--reply">
            <div className="post__body">
              <div className="post__head">
                {row.author && (
                  <span className="post__name" title={row.author}>
                    {row.author}
                  </span>
                )}
                {row.trip && <span className="post__trip">!!{row.trip}</span>}
                <span className="post__meta">No.{row.no ?? "?"} {fmtTs(row.ts)}</span>
                <button onClick={() => onClickReply(row)} title="Reply" style={{ marginLeft: 10, padding: "2px 8px", border: "1px solid #9cb", borderRadius: 6, background: "#eef2ff", cursor: "pointer", whiteSpace: "nowrap" }}>Reply</button>
              </div>
              <div className="post__text">{renderBody(row.body)}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Pager (bottom) */}
      <Pager
        currentPage={currentPage}
        totalPages={totalPages}
        onPrev={prevPage}
        onNext={nextPage}
        onJump={goToPage}
        model={pageModel}
      />
    </section>
  );
}

// ------------- Pager Component (unchanged) -------------
function Pager({ currentPage, totalPages, onPrev, onNext, onJump, model }) {
  const [inputPage, setInputPage] = useState("");

  function handleSubmit(e) {
    e.preventDefault();
    const n = parseInt(String(inputPage), 10);
    if (!Number.isNaN(n)) onJump(n);
    setInputPage("");
  }

  return (
    <div style={{ margin: "10px 0" }}>
      {/* Row 1: number buttons */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {model.map((tok, i) =>
          tok === "..." ? (
            <span key={`gap-${i}`} style={{ marginRight: 6 }}>…</span>
          ) : (
            <button
              key={tok}
              className="chan-link"
              onClick={() => onJump(tok)}
              aria-current={tok === currentPage ? "page" : undefined}
              style={tok === currentPage ? { fontWeight: 900, textDecoration: "underline" } : undefined}
            >
              [{tok}]
            </button>
          )
        )}
      </div>

      {/* Row 2: prev/next + jump */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
        <button className="chan-link" onClick={onPrev} disabled={currentPage <= 1}>[prev]</button>
        <button className="chan-link" onClick={onNext} disabled={currentPage >= totalPages}>[next]</button>

        <form onSubmit={handleSubmit} style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 8 }}>
          <label className="chan-label" htmlFor="jumpPage">Page:</label>
          <input
            id="jumpPage"
            type="number"
            min={1}
            max={totalPages}
            value={inputPage}
            onChange={(e) => setInputPage(e.target.value)}
            style={{ width: 80 }}
            placeholder={`${currentPage}/${totalPages}`}
          />
          <button className="chan-link" type="submit">[go]</button>
        </form>
      </div>
    </div>
  );
}
