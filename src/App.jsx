import { useState, useEffect, useCallback, useRef } from "react";
import * as XLSX from "xlsx";

// ── Supabase config ──
const SUPABASE_URL = "https://xcqhdqiwjbznogyknbzq.supabase.co";
const SUPABASE_KEY = "sb_publishable_Qq2wKi6JOS2olbgCubqxlQ_lGVcXBZf";

async function sbGet(monthKey) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/kakebo?month_key=eq.${monthKey}&select=data`, {
    headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
  });
  const rows = await res.json();
  return rows?.[0]?.data || null;
}

async function sbUpsert(monthKey, data) {
  await fetch(`${SUPABASE_URL}/rest/v1/kakebo`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates"
    },
    body: JSON.stringify({ month_key: monthKey, data })
  });
}

// ── Supabase Realtime ──
function subscribeToMonth(monthKey, onUpdate) {
  const wsUrl = SUPABASE_URL.replace("https://", "wss://") + "/realtime/v1/websocket?apikey=" + SUPABASE_KEY + "&vsn=1.0.0";
  const ws = new WebSocket(wsUrl);
  let heartbeat;

  ws.onopen = () => {
    ws.send(JSON.stringify({ topic: "realtime:public:kakebo", event: "phx_join", payload: { config: { broadcast: { self: false }, presence: { key: "" }, postgres_changes: [{ event: "UPDATE", schema: "public", table: "kakebo", filter: `month_key=eq.${monthKey}` }, { event: "INSERT", schema: "public", table: "kakebo", filter: `month_key=eq.${monthKey}` }] } }, ref: "1" }));
    heartbeat = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: "hb" })), 25000);
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.event === "postgres_changes" && msg.payload?.data?.record?.data) {
        onUpdate(msg.payload.data.record.data);
      }
    } catch {}
  };

  ws.onclose = () => clearInterval(heartbeat);

  return () => { clearInterval(heartbeat); ws.close(); };
}

// ── Export to Excel ──
function exportToExcel(mdata, year, month, weeks, MONTHS, CATEGORIES) {
  const wb = XLSX.utils.book_new();
  const monthName = MONTHS[month];

  // Sheet 1: Monthly data
  const rows = [];

  // Ingresos
  rows.push(["INGRESOS", "", ""]);
  rows.push(["Fecha", "Concepto", "Importe"]);
  mdata.ingresos.forEach(i => rows.push([i.fecha, i.concepto, parseFloat(i.importe) || 0]));
  const totalIngresos = mdata.ingresos.reduce((s, i) => s + (parseFloat(i.importe) || 0), 0);
  rows.push(["", "TOTAL INGRESOS", totalIngresos]);
  rows.push([]);

  // Gastos fijos
  rows.push(["GASTOS FIJOS", ""]);
  rows.push(["Concepto", "Importe"]);
  mdata.gastosFijos.forEach(g => rows.push([g.concepto, parseFloat(g.importe) || 0]));
  const totalFijos = mdata.gastosFijos.reduce((s, g) => s + (parseFloat(g.importe) || 0), 0);
  rows.push(["TOTAL GASTOS FIJOS", totalFijos]);
  rows.push([]);

  // Gastos semanales
  rows.push(["GASTOS SEMANALES", "", "", "", ""]);
  rows.push(["Semana", "Día", "Categoría", "Concepto", "Importe"]);
  let totalGastos = 0;
  weeks.forEach((week, wIdx) => {
    week.forEach(day => {
      CATEGORIES.forEach(cat => {
        const entries = mdata.gastos[`${day}-${cat.id}`] || [];
        entries.forEach(e => {
          const imp = parseFloat(e.importe) || 0;
          rows.push([`Semana ${wIdx + 1}`, day, cat.label, e.concepto, imp]);
          totalGastos += imp;
        });
      });
    });
  });
  rows.push(["", "", "", "TOTAL GASTOS", totalGastos]);
  rows.push([]);

  // Resumen
  const ahorroPrevisto = parseFloat(mdata.ahorroPrevisto) || 0;
  const ahorroReal = totalIngresos - totalFijos - totalGastos;
  rows.push(["RESUMEN", "", "", "", ""]);
  rows.push(["Total ingresos", "Total fijos", "Total gastos semanales", "Ahorro previsto", "Ahorro real"]);
  rows.push([totalIngresos, totalFijos, totalGastos, ahorroPrevisto, ahorroReal]);
  rows.push([]);

  // Reflexión
  if (mdata.reflexion?.objetivos || mdata.reflexion?.promesas || mdata.reflexion?.balance || mdata.reflexion?.mejora) {
    rows.push(["REFLEXIÓN"]);
    if (mdata.reflexion?.objetivos) rows.push(["Objetivos", mdata.reflexion.objetivos]);
    if (mdata.reflexion?.promesas) rows.push(["Promesas", mdata.reflexion.promesas]);
    if (mdata.reflexion?.balance) rows.push(["Balance", mdata.reflexion.balance]);
    if (mdata.reflexion?.mejora) rows.push(["Mejora", mdata.reflexion.mejora]);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 22 }, { wch: 28 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, ws, monthName + " " + year);

  XLSX.writeFile(wb, `kakebo-${monthName.toLowerCase()}-${year}.xlsx`);
}

const CATEGORIES = [
  { id: "supervivencia", label: "Supervivencia", color: "#7bc47f", bg: "#f0faf0", emoji: "🌿" },
  { id: "ocio", label: "Ocio y Vicio", color: "#f4a261", bg: "#fff8f0", emoji: "🍊" },
  { id: "cultura", label: "Cultura", color: "#74b3ce", bg: "#f0f7fc", emoji: "📘" },
  { id: "extras", label: "Extras", color: "#e07a7a", bg: "#fdf0f0", emoji: "⭐" },
];

const MONTHS = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const today = new Date();

function getWeeksInMonth(year, month) {
  const weeks = [];
  let weekStart = new Date(year, month, 1);
  while (weekStart.getMonth() === month) {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(weekStart);
      day.setDate(weekStart.getDate() + i);
      if (day.getMonth() === month) days.push(day.getDate());
    }
    if (days.length) weeks.push(days);
    weekStart.setDate(weekStart.getDate() + 7);
  }
  return weeks;
}

function monthKey(year, month) { return `${year}-${month}`; }
function initMonth() {
  return { ingresos: [], gastosFijos: [], ahorroPrevisto: "", gastos: {}, creditCard: [], reflexion: { objetivos: "", promesas: "", balance: "", mejora: "" } };
}

export default function Kakebo() {
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [view, setView] = useState("mes");
  const [weekIdx, setWeekIdx] = useState(0);
  const [mdata, setMdata] = useState(initMonth());
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState(null);
  const saveTimer = useRef(null);
  const isSaving = useRef(false);

  const key = monthKey(year, month);

  useEffect(() => {
    setLoading(true);
    sbGet(key).then(data => {
      setMdata(data || initMonth());
      setLoading(false);
    }).catch(() => {
      setMdata(initMonth());
      setLoading(false);
    });
  }, [key]);

  // Realtime — actualiza cuando otro dispositivo guarda
  useEffect(() => {
    const unsub = subscribeToMonth(key, (newData) => {
      if (!isSaving.current) setMdata(newData);
    });
    return unsub;
  }, [key]);

  function updateMonth(newMdata) {
    setMdata(newMdata);
    setSaveStatus("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        isSaving.current = true;
        await sbUpsert(key, newMdata);
        isSaving.current = false;
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus(null), 2000);
      } catch {
        isSaving.current = false;
        setSaveStatus("error");
      }
    }, 800);
  }

  const weeks = getWeeksInMonth(year, month);
  const totalIngresos = mdata.ingresos.reduce((s, i) => s + (parseFloat(i.importe) || 0), 0);
  const totalFijos = mdata.gastosFijos.reduce((s, i) => s + (parseFloat(i.importe) || 0), 0);
  const ahorroPrevisto = parseFloat(mdata.ahorroPrevisto) || 0;
  const presupuesto = totalIngresos - totalFijos - ahorroPrevisto;

  function weeklyTotal(wIdx, catId) {
    return (weeks[wIdx] || []).reduce((sum, day) => sum + (mdata.gastos[`${day}-${catId}`] || []).reduce((s, e) => s + (parseFloat(e.importe) || 0), 0), 0);
  }
  function totalGastosSemana(wIdx) { return CATEGORIES.reduce((s, c) => s + weeklyTotal(wIdx, c.id), 0); }
  function totalGastosMes() { return weeks.reduce((s, _, i) => s + totalGastosSemana(i), 0); }
  function totalCategoriaMes(catId) { return weeks.reduce((s, _, i) => s + weeklyTotal(i, catId), 0); }
  const ahorroReal = totalIngresos - totalFijos - totalGastosMes();

  function addIngreso() { updateMonth({ ...mdata, ingresos: [...mdata.ingresos, { fecha: "", concepto: "", importe: "" }] }); }
  function updateIngreso(idx, f, v) { const a = [...mdata.ingresos]; a[idx] = { ...a[idx], [f]: v }; updateMonth({ ...mdata, ingresos: a }); }
  function removeIngreso(idx) { updateMonth({ ...mdata, ingresos: mdata.ingresos.filter((_, i) => i !== idx) }); }
  function addFijo() { updateMonth({ ...mdata, gastosFijos: [...mdata.gastosFijos, { concepto: "", importe: "" }] }); }
  function updateFijo(idx, f, v) { const a = [...mdata.gastosFijos]; a[idx] = { ...a[idx], [f]: v }; updateMonth({ ...mdata, gastosFijos: a }); }
  function removeFijo(idx) { updateMonth({ ...mdata, gastosFijos: mdata.gastosFijos.filter((_, i) => i !== idx) }); }
  function addGasto(day, catId, concepto, importe) {
    const k = `${day}-${catId}`;
    updateMonth({ ...mdata, gastos: { ...mdata.gastos, [k]: [...(mdata.gastos[k] || []), { concepto, importe }] } });
  }
  function removeGasto(day, catId, eIdx) {
    const k = `${day}-${catId}`;
    updateMonth({ ...mdata, gastos: { ...mdata.gastos, [k]: (mdata.gastos[k] || []).filter((_, i) => i !== eIdx) } });
  }
  function prevMonth() { if (month === 0) { setYear(y => y-1); setMonth(11); } else setMonth(m => m-1); setWeekIdx(0); setView("mes"); }
  function nextMonth() { if (month === 11) { setYear(y => y+1); setMonth(0); } else setMonth(m => m+1); setWeekIdx(0); setView("mes"); }

  return (
    <div style={{ fontFamily: "'Georgia','Times New Roman',serif", minHeight: "100vh", background: "#faf7f2", color: "#2a2a2a" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700;900&family=Source+Sans+3:wght@300;400;600&display=swap');
        * { box-sizing: border-box; }
        .btn { cursor: pointer; border: none; border-radius: 4px; padding: 6px 14px; font-size: 13px; font-family: 'Source Sans 3', sans-serif; transition: opacity 0.15s; }
        .btn:hover { opacity: 0.8; }
        .btn-pink { background: #e83e8c; color: white; }
        .btn-ghost { background: transparent; border: 1.5px solid #ccc; color: #555; }
        .btn-sm { padding: 3px 9px; font-size: 12px; }
        input[type=text], input[type=number] { border: none; border-bottom: 1.5px solid #ccc; background: transparent; font-family: 'Source Sans 3', sans-serif; font-size: 13px; color: #2a2a2a; outline: none; width: 100%; padding: 2px 4px; }
        input[type=text]:focus, input[type=number]:focus { border-bottom-color: #e83e8c; }
        select { border: none; border-bottom: 1.5px solid #ccc; background: transparent; font-family: 'Source Sans 3', sans-serif; font-size: 13px; outline: none; padding: 2px 4px; }
        textarea { border: 1px solid #ddd; border-radius: 6px; font-family: 'Source Sans 3', sans-serif; font-size: 13px; width: 100%; padding: 8px; outline: none; resize: vertical; background: white; }
        textarea:focus { border-color: #e83e8c; }
        .tab { cursor: pointer; padding: 8px 18px; border-radius: 20px; font-size: 13px; font-family: 'Source Sans 3', sans-serif; transition: all 0.2s; border: 1.5px solid transparent; }
        .tab.active { background: #e83e8c; color: white; }
        .tab:not(.active) { background: white; color: #666; border-color: #ddd; }
        .tab:not(.active):hover { border-color: #e83e8c; color: #e83e8c; }
        .gastos-grid td, .gastos-grid th { padding: 5px 7px; font-size: 12px; border-bottom: 1px solid #eee; }
        .gastos-grid th { font-weight: 600; color: #666; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
        .fade-in { animation: fadeIn 0.3s ease; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        @keyframes spin { to { transform: rotate(360deg); } }
        .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid #eee; border-top-color: #e83e8c; border-radius: 50%; animation: spin 0.6s linear infinite; }
      `}</style>

      <div style={{ maxWidth: 800, margin: "0 auto", padding: "16px 12px" }}>
        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 11, letterSpacing: "0.25em", textTransform: "uppercase", color: "#999", marginBottom: 4 }}>Libro de cuentas para el ahorro doméstico</div>
          <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 36, fontWeight: 900, color: "#e83e8c", letterSpacing: 2, lineHeight: 1 }}>KAKEBO</div>
          <div style={{ fontSize: 11, color: "#aaa", letterSpacing: "0.15em", marginTop: 2 }}>家計簿</div>
          <div style={{ height: 20, marginTop: 6, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            {saveStatus === "saving" && <><span className="spinner" /><span style={{ fontSize: 11, color: "#aaa" }}>Guardando...</span></>}
            {saveStatus === "saved" && <span style={{ fontSize: 11, color: "#7bc47f" }}>✓ Guardado en la nube</span>}
            {saveStatus === "error" && <span style={{ fontSize: 11, color: "#e07a7a" }}>⚠ Error al guardar</span>}
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 16, marginTop: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={prevMonth}>‹</button>
            <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 22, fontWeight: 700, minWidth: 200, textAlign: "center" }}>{MONTHS[month]} {year}</div>
            <button className="btn btn-ghost btn-sm" onClick={nextMonth}>›</button>
          </div>
          <div style={{ marginTop: 10 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => exportToExcel(mdata, year, month, weeks, MONTHS, CATEGORIES)} style={{ fontSize: 12, color: "#2a9d8f", borderColor: "#2a9d8f" }}>
              ⬇ Exportar Excel
            </button>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", marginBottom: 20 }}>
          <span className={`tab ${view === "mes" ? "active" : ""}`} onClick={() => setView("mes")}>① Inicio de mes</span>
          {weeks.map((_, i) => (
            <span key={i} className={`tab ${view === "semana" && weekIdx === i ? "active" : ""}`} onClick={() => { setView("semana"); setWeekIdx(i); }}>② Semana {i+1}</span>
          ))}
          <span className={`tab ${view === "final" ? "active" : ""}`} onClick={() => setView("final")}>③ Final de mes</span>
        </div>

        {loading ? (
          <div style={{ textAlign: "center", padding: 60, color: "#aaa" }}>
            <div className="spinner" style={{ width: 24, height: 24, margin: "0 auto 12px", borderWidth: 3 }} />
            <div style={{ fontSize: 13 }}>Cargando datos...</div>
          </div>
        ) : (
          <>
            {view === "mes" && (
              <div className="fade-in">
                <SectionTitle>Las cuentas claras, mes a mes</SectionTitle>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
                  <Card color="#7bc47f">
                    <CardTitle color="#7bc47f">INGRESOS · 収入</CardTitle>
                    <table style={{ width: "100%", borderCollapse: "collapse" }} className="gastos-grid">
                      <thead><tr><th>Fecha</th><th>Concepto</th><th>Importe</th><th></th></tr></thead>
                      <tbody>
                        {mdata.ingresos.map((row, i) => (
                          <tr key={i}>
                            <td><input type="text" value={row.fecha} onChange={e => updateIngreso(i, "fecha", e.target.value)} placeholder="dd/mm" style={{ width: 50 }} /></td>
                            <td><input type="text" value={row.concepto} onChange={e => updateIngreso(i, "concepto", e.target.value)} placeholder="Concepto" /></td>
                            <td><input type="number" value={row.importe} onChange={e => updateIngreso(i, "importe", e.target.value)} placeholder="0" style={{ width: 60 }} /></td>
                            <td><button style={{ background: "none", border: "none", cursor: "pointer", color: "#ccc", fontSize: 14 }} onClick={() => removeIngreso(i)}>✕</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <button className="btn btn-sm" style={{ background: "#7bc47f", color: "white" }} onClick={addIngreso}>+ Añadir</button>
                      <TotalBadge color="#7bc47f">{totalIngresos.toFixed(2)} €</TotalBadge>
                    </div>
                  </Card>
                  <Card color="#e07a7a">
                    <CardTitle color="#e07a7a">GASTOS FIJOS · 支出</CardTitle>
                    <table style={{ width: "100%", borderCollapse: "collapse" }} className="gastos-grid">
                      <thead><tr><th>Concepto</th><th>Importe</th><th></th></tr></thead>
                      <tbody>
                        {mdata.gastosFijos.map((row, i) => (
                          <tr key={i}>
                            <td><input type="text" value={row.concepto} onChange={e => updateFijo(i, "concepto", e.target.value)} placeholder="Concepto" /></td>
                            <td><input type="number" value={row.importe} onChange={e => updateFijo(i, "importe", e.target.value)} placeholder="0" style={{ width: 60 }} /></td>
                            <td><button style={{ background: "none", border: "none", cursor: "pointer", color: "#ccc", fontSize: 14 }} onClick={() => removeFijo(i)}>✕</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <button className="btn btn-sm" style={{ background: "#e07a7a", color: "white" }} onClick={addFijo}>+ Añadir</button>
                      <TotalBadge color="#e07a7a">{totalFijos.toFixed(2)} €</TotalBadge>
                    </div>
                  </Card>
                </div>
                <Card color="#e83e8c" style={{ marginBottom: 16 }}>
                  <CardTitle color="#e83e8c">PRESUPUESTO MENSUAL · 予算</CardTitle>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
                    <BigNumber color="#7bc47f">{totalIngresos.toFixed(0)} €</BigNumber><Op>−</Op>
                    <BigNumber color="#e07a7a">{totalFijos.toFixed(0)} €</BigNumber><Op>=</Op>
                    <BigNumber color="#2a9d8f">{(totalIngresos-totalFijos).toFixed(0)} €</BigNumber>
                  </div>
                  <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <label style={{ fontSize: 13, color: "#666" }}>Ahorro previsto:</label>
                    <input type="number" value={mdata.ahorroPrevisto} onChange={e => updateMonth({ ...mdata, ahorroPrevisto: e.target.value })} placeholder="0" style={{ width: 80, fontSize: 16, fontWeight: 700 }} />
                    <span style={{ color: "#666" }}>€</span><Op>=</Op>
                    <BigNumber color="#e83e8c">{presupuesto.toFixed(0)} €</BigNumber>
                    <span style={{ fontSize: 12, color: "#999" }}>disponible para gastos semanales</span>
                  </div>
                </Card>
                <Card color="#74b3ce">
                  <CardTitle color="#74b3ce">OBJETIVOS Y PROMESAS</CardTitle>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#74b3ce", display: "block", marginBottom: 4 }}>¿Cuáles son tus objetivos mensuales?</label>
                  <textarea rows={2} value={mdata.reflexion?.objetivos || ""} onChange={e => updateMonth({ ...mdata, reflexion: { ...mdata.reflexion, objetivos: e.target.value } })} placeholder="Escribe tus objetivos para este mes..." />
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#74b3ce", display: "block", margin: "10px 0 4px" }}>¿Y tus promesas?</label>
                  <textarea rows={2} value={mdata.reflexion?.promesas || ""} onChange={e => updateMonth({ ...mdata, reflexion: { ...mdata.reflexion, promesas: e.target.value } })} placeholder="Anota tus promesas kakebo..." />
                </Card>
              </div>
            )}
            {view === "semana" && (
              <WeekView
                key={`${key}-w${weekIdx}`}
                week={weeks[weekIdx] || []} weekNum={weekIdx+1} mdata={mdata} presupuesto={presupuesto}
                gastosPrevios={weeks.slice(0, weekIdx).reduce((s, _, i) => s + totalGastosSemana(i), 0)}
                addGasto={addGasto} removeGasto={removeGasto}
                weeklyTotal={(catId) => weeklyTotal(weekIdx, catId)}
                totalSemana={() => totalGastosSemana(weekIdx)}
                month={month} year={year}
              />
            )}
            {view === "final" && (
              <FinalView
                weeks={weeks} mdata={mdata} updateMonth={updateMonth}
                totalIngresos={totalIngresos} totalFijos={totalFijos} ahorroPrevisto={ahorroPrevisto}
                ahorroReal={ahorroReal} totalGastosMes={totalGastosMes()}
                totalCategoriaMes={totalCategoriaMes} weeklyTotal={weeklyTotal} totalGastosSemana={totalGastosSemana}
              />
            )}
          </>
        )}
        <div style={{ textAlign: "center", marginTop: 24, paddingTop: 16, borderTop: "1px solid #eee", fontSize: 11, color: "#ccc", letterSpacing: "0.1em" }}>
          KAKEBO · 家計簿 · El método japonés para aprender a ahorrar
        </div>
      </div>
    </div>
  );
}

function WeekView({ week, weekNum, mdata, presupuesto, gastosPrevios, addGasto, removeGasto, weeklyTotal, totalSemana, month, year }) {
  const [newEntry, setNewEntry] = useState({ day: week[0] || 1, catId: "supervivencia", concepto: "", importe: "" });
  const [showForm, setShowForm] = useState(false);
  const DAYS_ES = ["L","M","X","J","V","S","D"];
  const disponible = presupuesto - gastosPrevios - totalSemana();
  function handleAdd() {
    if (!newEntry.concepto || !newEntry.importe) return;
    addGasto(newEntry.day, newEntry.catId, newEntry.concepto, newEntry.importe);
    setNewEntry(n => ({ ...n, concepto: "", importe: "" }));
  }
  return (
    <div className="fade-in">
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <SectionTitle>Semana {weekNum}</SectionTitle>
        <span style={{ fontSize: 12, color: "#aaa" }}>Días {week[0]}–{week[week.length-1]}</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 12, color: "#666" }}>Disponible:</span>
          <TotalBadge color={disponible >= 0 ? "#2a9d8f" : "#e07a7a"}>{disponible.toFixed(2)} €</TotalBadge>
        </div>
      </div>
      <div style={{ overflowX: "auto", marginBottom: 16 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", background: "white", borderRadius: 10, overflow: "hidden", boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
          <thead>
            <tr style={{ background: "#f8f4ef" }}>
              <th style={{ padding: "10px 12px", fontSize: 11, color: "#999", textAlign: "left", fontWeight: 600, textTransform: "uppercase", width: 110 }}>Categoría</th>
              {week.map(d => (
                <th key={d} style={{ padding: "10px 8px", fontSize: 12, color: "#555", textAlign: "center", fontWeight: 600, minWidth: 52 }}>
                  <div>{d}</div>
                  <div style={{ fontSize: 10, color: "#bbb", fontWeight: 400 }}>{DAYS_ES[(new Date(year, month, d).getDay()+6)%7]}</div>
                </th>
              ))}
              <th style={{ padding: "10px 8px", fontSize: 11, color: "#999", textAlign: "center", fontWeight: 700 }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {CATEGORIES.map(cat => (
              <tr key={cat.id} style={{ borderBottom: "1px solid #f0ebe3" }}>
                <td style={{ padding: "10px 12px", background: cat.bg }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: cat.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 11, fontWeight: 600, color: cat.color }}>{cat.label}</span>
                  </div>
                </td>
                {week.map(d => {
                  const entries = mdata.gastos[`${d}-${cat.id}`] || [];
                  return (
                    <td key={d} style={{ padding: "6px 4px", textAlign: "center", verticalAlign: "top", background: entries.length ? cat.bg : "white" }}>
                      {entries.map((e, i) => (
                        <div key={i} style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 2, justifyContent: "center", marginBottom: 2 }}>
                          <span style={{ color: cat.color, fontWeight: 600 }}>{parseFloat(e.importe).toFixed(0)}€</span><span style={{ color: "#888", fontSize: 10, marginLeft: 3 }}>{e.concepto}</span>
                          <button onClick={() => removeGasto(d, cat.id, i)} style={{ background: "none", border: "none", cursor: "pointer", color: "#ddd", fontSize: 9, padding: 0 }}>✕</button>
                        </div>
                      ))}
                    </td>
                  );
                })}
                <td style={{ padding: "10px 8px", textAlign: "center", fontWeight: 700, fontSize: 13, color: cat.color, background: cat.bg }}>
                  {weeklyTotal(cat.id) > 0 ? `${weeklyTotal(cat.id).toFixed(2)}€` : "—"}
                </td>
              </tr>
            ))}
            <tr style={{ background: "#f8f4ef", borderTop: "2px solid #eee" }}>
              <td style={{ padding: "10px 12px", fontSize: 12, fontWeight: 700, color: "#555" }}>TOTAL DÍA</td>
              {week.map(d => {
                const dt = CATEGORIES.reduce((s, c) => s + (mdata.gastos[`${d}-${c.id}`] || []).reduce((ss, e) => ss + (parseFloat(e.importe)||0), 0), 0);
                return <td key={d} style={{ padding: "10px 4px", textAlign: "center", fontWeight: 700, fontSize: 12 }}>{dt > 0 ? `${dt.toFixed(0)}€` : "—"}</td>;
              })}
              <td style={{ padding: "10px 8px", textAlign: "center" }}><TotalBadge color="#e83e8c">{totalSemana().toFixed(2)} €</TotalBadge></td>
            </tr>
          </tbody>
        </table>
      </div>
      <Card color="#e83e8c">
        <div style={{ display: "flex", alignItems: "center", marginBottom: showForm ? 12 : 0 }}>
          <CardTitle color="#e83e8c" style={{ margin: 0 }}>AÑADIR GASTO</CardTitle>
          <button className="btn btn-pink btn-sm" style={{ marginLeft: "auto" }} onClick={() => setShowForm(s => !s)}>{showForm ? "Cerrar" : "+ Nuevo gasto"}</button>
        </div>
        {showForm && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div>
              <label style={{ fontSize: 11, color: "#999", display: "block", marginBottom: 2 }}>Día</label>
              <select value={newEntry.day} onChange={e => setNewEntry(n => ({ ...n, day: parseInt(e.target.value) }))}>
                {week.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 11, color: "#999", display: "block", marginBottom: 2 }}>Categoría</label>
              <select value={newEntry.catId} onChange={e => setNewEntry(n => ({ ...n, catId: e.target.value }))}>
                {CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.emoji} {c.label}</option>)}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 120 }}>
              <label style={{ fontSize: 11, color: "#999", display: "block", marginBottom: 2 }}>Concepto</label>
              <input type="text" value={newEntry.concepto} onChange={e => setNewEntry(n => ({ ...n, concepto: e.target.value }))} placeholder="Mercadona, café..." onKeyDown={e => e.key === "Enter" && handleAdd()} />
            </div>
            <div style={{ width: 80 }}>
              <label style={{ fontSize: 11, color: "#999", display: "block", marginBottom: 2 }}>Importe €</label>
              <input type="number" value={newEntry.importe} onChange={e => setNewEntry(n => ({ ...n, importe: e.target.value }))} placeholder="0.00" onKeyDown={e => e.key === "Enter" && handleAdd()} />
            </div>
            <button className="btn btn-pink" onClick={handleAdd}>Añadir</button>
          </div>
        )}
      </Card>
      <div style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap" }}>
        {CATEGORIES.map(cat => (
          <div key={cat.id} style={{ background: cat.bg, border: `1px solid ${cat.color}30`, borderRadius: 8, padding: "6px 12px", fontSize: 11 }}>
            <span style={{ color: cat.color, fontWeight: 700 }}>{cat.emoji} {cat.label}</span>
            <span style={{ color: "#888", marginLeft: 6 }}>{weeklyTotal(cat.id).toFixed(2)} €</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FinalView({ weeks, mdata, updateMonth, totalIngresos, totalFijos, ahorroPrevisto, ahorroReal, totalGastosMes, totalCategoriaMes, weeklyTotal, totalGastosSemana }) {
  const superavit = ahorroReal >= ahorroPrevisto;
  function addCC() { updateMonth({ ...mdata, creditCard: [...(mdata.creditCard||[]), { fecha:"", tarjeta:"", comercio:"", dPago:"", importe:"" }] }); }
  function updateCC(idx, f, v) { const a = [...(mdata.creditCard||[])]; a[idx] = { ...a[idx], [f]: v }; updateMonth({ ...mdata, creditCard: a }); }
  function removeCC(idx) { updateMonth({ ...mdata, creditCard: (mdata.creditCard||[]).filter((_,i) => i !== idx) }); }
  return (
    <div className="fade-in">
      <SectionTitle>Haz balance cada final de mes · 月末</SectionTitle>
      <Card color="#e83e8c" style={{ marginBottom: 16 }}>
        <CardTitle color="#e83e8c">BALANCE MENSUAL</CardTitle>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }} className="gastos-grid">
            <thead><tr><th style={{ textAlign: "left" }}></th>{weeks.map((_,i) => <th key={i} style={{ textAlign: "center" }}>Sem. {i+1}</th>)}<th style={{ textAlign: "center" }}>TOTAL</th></tr></thead>
            <tbody><tr><td style={{ fontWeight: 600, color: "#555" }}>Total gastos</td>{weeks.map((_,i) => <td key={i} style={{ textAlign: "center" }}>{totalGastosSemana(i).toFixed(2)} €</td>)}<td style={{ textAlign: "center", fontWeight: 700, color: "#e83e8c" }}>{totalGastosMes.toFixed(2)} €</td></tr></tbody>
          </table>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 16, alignItems: "center", justifyContent: "center" }}>
          <BalanceBlock label="Ingresos" value={totalIngresos} color="#7bc47f" />
          <Op>−</Op><BalanceBlock label="Gastos fijos" value={totalFijos} color="#e07a7a" />
          <Op>−</Op><BalanceBlock label="Gastos semanales" value={totalGastosMes} color="#f4a261" />
          <Op>=</Op><BalanceBlock label="Ahorro real" value={ahorroReal} color={superavit ? "#2a9d8f" : "#e07a7a"} big />
        </div>
        <div style={{ textAlign: "center", marginTop: 14, padding: 12, background: superavit ? "#f0faf5" : "#fdf5f5", borderRadius: 8, border: `1.5px solid ${superavit ? "#7bc47f" : "#e07a7a"}` }}>
          <span style={{ fontSize: 22 }}>{superavit ? "🎉" : "💪"}</span>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: superavit ? "#2a9d8f" : "#e07a7a", fontWeight: 600 }}>
            {superavit ? `¡Has superado tu objetivo! Ahorraste ${ahorroReal.toFixed(2)} € (objetivo: ${ahorroPrevisto.toFixed(2)} €)` : `Este mes ahorraste ${ahorroReal.toFixed(2)} € (objetivo: ${ahorroPrevisto.toFixed(2)} €)`}
          </p>
        </div>
      </Card>
      <Card color="#74b3ce" style={{ marginBottom: 16 }}>
        <CardTitle color="#74b3ce">RESUMEN POR CATEGORÍA</CardTitle>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }} className="gastos-grid">
            <thead><tr><th style={{ textAlign: "left" }}>Categoría</th>{weeks.map((_,i) => <th key={i} style={{ textAlign: "center" }}>Sem. {i+1}</th>)}<th style={{ textAlign: "center" }}>Total</th><th style={{ textAlign: "center" }}>%</th></tr></thead>
            <tbody>
              {CATEGORIES.map(cat => {
                const total = totalCategoriaMes(cat.id);
                const pct = totalGastosMes > 0 ? (total/totalGastosMes*100).toFixed(1) : "0.0";
                return (
                  <tr key={cat.id}>
                    <td style={{ background: cat.bg, padding: "8px 10px" }}><span style={{ color: cat.color, fontWeight: 600 }}>{cat.emoji} {cat.label}</span></td>
                    {weeks.map((_,i) => <td key={i} style={{ textAlign: "center", background: weeklyTotal(i, cat.id) > 0 ? cat.bg : "white" }}>{weeklyTotal(i, cat.id) > 0 ? `${weeklyTotal(i, cat.id).toFixed(2)} €` : "—"}</td>)}
                    <td style={{ textAlign: "center", fontWeight: 700, color: cat.color, background: cat.bg }}>{total.toFixed(2)} €</td>
                    <td style={{ textAlign: "center", color: "#888" }}>{pct}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <Card color="#f4a261" style={{ marginBottom: 16 }}>
        <CardTitle color="#f4a261">TARJETA DE CRÉDITO</CardTitle>
        <table style={{ width: "100%", borderCollapse: "collapse" }} className="gastos-grid">
          <thead><tr><th>Fecha</th><th>Tarjeta</th><th>Comercio</th><th>Día pago</th><th>Importe</th><th></th></tr></thead>
          <tbody>
            {(mdata.creditCard||[]).map((row, i) => (
              <tr key={i}>
                <td><input type="text" value={row.fecha} onChange={e => updateCC(i,"fecha",e.target.value)} placeholder="dd/mm" style={{ width: 55 }} /></td>
                <td><input type="text" value={row.tarjeta} onChange={e => updateCC(i,"tarjeta",e.target.value)} placeholder="Visa..." style={{ width: 65 }} /></td>
                <td><input type="text" value={row.comercio} onChange={e => updateCC(i,"comercio",e.target.value)} placeholder="Comercio" /></td>
                <td><input type="text" value={row.dPago} onChange={e => updateCC(i,"dPago",e.target.value)} placeholder="dd/mm" style={{ width: 55 }} /></td>
                <td><input type="number" value={row.importe} onChange={e => updateCC(i,"importe",e.target.value)} placeholder="0" style={{ width: 65 }} /></td>
                <td><button style={{ background: "none", border: "none", cursor: "pointer", color: "#ccc", fontSize: 14 }} onClick={() => removeCC(i)}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ marginTop: 8 }}><button className="btn btn-sm" style={{ background: "#f4a261", color: "white" }} onClick={addCC}>+ Añadir</button></div>
      </Card>
      <Card color="#9b59b6">
        <CardTitle color="#9b59b6">REFLEXIÓN FINAL DEL MES</CardTitle>
        <label style={{ fontSize: 12, fontWeight: 600, color: "#9b59b6", display: "block", marginBottom: 4 }}>¿He conseguido mis objetivos mensuales?</label>
        <textarea rows={2} value={mdata.reflexion?.balance||""} onChange={e => updateMonth({ ...mdata, reflexion: { ...mdata.reflexion, balance: e.target.value } })} placeholder="Reflexiona sobre el mes..." />
        <label style={{ fontSize: 12, fontWeight: 600, color: "#9b59b6", display: "block", margin: "10px 0 4px" }}>¿Qué puedo mejorar el mes que viene?</label>
        <textarea rows={2} value={mdata.reflexion?.mejora||""} onChange={e => updateMonth({ ...mdata, reflexion: { ...mdata.reflexion, mejora: e.target.value } })} placeholder="Anota tus aprendizajes..." />
      </Card>
    </div>
  );
}

function SectionTitle({ children }) { return <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 16, fontWeight: 700, color: "#2a2a2a", marginBottom: 12, paddingBottom: 6, borderBottom: "2px solid #f0ebe3", letterSpacing: "0.03em" }}>{children}</div>; }
function Card({ children, color, style={} }) { return <div style={{ background: "white", borderRadius: 10, padding: "14px 16px", boxShadow: "0 2px 12px rgba(0,0,0,0.06)", borderTop: `3px solid ${color}`, ...style }}>{children}</div>; }
function CardTitle({ children, color, style={} }) { return <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color, marginBottom: 8, ...style }}>{children}</div>; }
function TotalBadge({ children, color }) { return <span style={{ background: color, color: "white", borderRadius: 20, padding: "3px 12px", fontSize: 13, fontWeight: 700 }}>{children}</span>; }
function BigNumber({ children, color }) { return <div style={{ fontSize: 24, fontWeight: 900, fontFamily: "'Playfair Display',serif", color }}>{children}</div>; }
function Op({ children }) { return <div style={{ fontSize: 20, color: "#ccc", fontWeight: 300 }}>{children}</div>; }
function BalanceBlock({ label, value, color, big }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: "#aaa", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: big ? 26 : 20, fontWeight: 900, fontFamily: "'Playfair Display',serif", color }}>{value.toFixed(2)} €</div>
    </div>
  );
}
