import React, { useEffect, useRef, useState } from "react";

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid(): Promise<typeof import("mermaid").default> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      m.default.initialize({ startOnLoad: false, theme: "default", securityLevel: "loose" });
      return m.default;
    }).catch((e) => {
      mermaidPromise = null; // allow retry on next mount
      throw e;
    });
  }
  return mermaidPromise;
}

export function MermaidBlock({ source }: { source: string }): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Fresh ID each effect run — avoids Strict Mode duplicate-ID crash in mermaid's temp container
    const renderId = `mmd-${Math.random().toString(36).slice(2, 10)}`;
    setError(null);

    loadMermaid()
      .then(async (mermaid) => {
        try {
          const { svg } = await mermaid.render(renderId, source);
          if (!cancelled && ref.current) ref.current.innerHTML = svg;
        } catch (e) {
          if (!cancelled) setError(String(e));
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });

    return () => {
      cancelled = true;
      // Remove mermaid's temp container so the next run can reuse the same ID space
      document.getElementById(renderId)?.remove();
    };
  }, [source]);

  if (error) {
    return (
      <pre className="mermaid-error">
        {error}
        {"\n\n"}
        {source}
      </pre>
    );
  }
  return <div ref={ref} className="mermaid-block" />;
}
