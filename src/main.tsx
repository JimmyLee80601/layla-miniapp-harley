import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

if (import.meta.env.DEV) {
  import("@layla-network/sdk").then(({ installLaylaMock }) => {
    const dbKey = "harley-studio:db";

    type MockRow = Record<string, unknown>;

    const loadRows = (): MockRow[] => {
      try {
        const raw = localStorage.getItem(dbKey);
        return raw ? (JSON.parse(raw) as MockRow[]) : [];
      } catch {
        return [];
      }
    };

    const saveRows = (rows: MockRow[]) =>
      localStorage.setItem(dbKey, JSON.stringify(rows));

    installLaylaMock({
      respond: (messages) => {
        const message = messages.at(-1);
        const imageNote = message?.image_base64
          ? " I received the attached image."
          : "";
        return `You said: ${message?.content ?? "(no text)"}.${imageNote} Mock response from Harley.`;
      },
      executeSql: (query: string, params: unknown[]) => {
        const sql = query.trim().toUpperCase();
        const rows = loadRows();

        if (sql.startsWith("INSERT")) {
          const insertId =
            rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;
          rows.push({
            id: insertId,
            role: params[0],
            content: params[1] ?? null,
            image_base64: params[2] ?? null,
            image_name: params[3] ?? null,
            timestamp: params[4] ?? Date.now(),
          });
          saveRows(rows);
          return { rows: [], rowsAffected: 1, insertId };
        }

        if (sql.startsWith("SELECT")) {
          return { rows, rowsAffected: 0, insertId: 0 };
        }

        if (sql.startsWith("DELETE")) {
          saveRows([]);
          return { rows: [], rowsAffected: rows.length, insertId: 0 };
        }

        return { rows: [], rowsAffected: 0, insertId: 0 };
      },
      latencyMs: 300,
      tokenDelayMs: 25,
    });
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
