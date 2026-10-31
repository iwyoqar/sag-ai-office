import { useState, type FormEvent } from "react";
import { BUSINESS_FUNCTIONS, type BusinessFunction, type CreatePlacedUnitInput, type NetworkDto, type UnitCardDto } from "@sag/shared";
import { api } from "../api/client";

/** functions a branch may have (HEADQUARTERS belongs to the head office only; the server enforces the same rule) */
const FUNCTIONS = BUSINESS_FUNCTIONS.filter((f) => f !== "HEADQUARTERS");
const FUNCTION_LABEL: Record<BusinessFunction, string> = {
  RETAIL: "Chakana savdo", WAREHOUSE: "Ombor", FACTORY: "Ishlab chiqarish", OFFICE: "Ofis", LOGISTICS: "Logistika",
  DEALER: "Diler", HEADQUARTERS: "Bosh ofis",
};

/**
 * New store / branch on the free map slot the user right-clicked. The slot travels with the request and the server
 * checks it again (it may have been taken meanwhile); ownership follows the type, as in the store import.
 */
export function CreateBranchModal({ slot, network, onClose, onCreated }: {
  slot: { gridX: number; gridZ: number };
  network: NetworkDto;
  onClose: () => void;
  onCreated: (unit: UnitCardDto) => void;
}) {
  const regions = network.regions;
  const [name, setName] = useState("");
  const [regionId, setRegionId] = useState(regions[0]?.id ?? "");
  const [businessType, setBusinessType] = useState<CreatePlacedUnitInput["businessType"]>("SAG_BRANCH");
  const [address, setAddress] = useState("");
  const [functions, setFunctions] = useState<BusinessFunction[]>(["RETAIL"]);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (f: BusinessFunction) => setFunctions((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]));
  const valid = name.trim().length >= 2 && !!regionId && functions.length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body: CreatePlacedUnitInput = {
        name: name.trim(), regionId, businessType, functions,
        address: address.trim() || null, description: description.trim() || null,
        placement: { gridX: slot.gridX, gridZ: slot.gridZ },
      };
      const r = await api.post<{ unit: UnitCardDto }>("/api/units", body);
      onCreated(r.unit);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal account branch" role="dialog" aria-label="Yangi filial" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="muted">Xaritadagi joy · katak {slot.gridX}, {slot.gridZ}</div>
            <h2>Yangi filial</h2>
          </div>
          <button className="close" onClick={onClose} aria-label="Yopish" disabled={busy}>×</button>
        </div>
        <form className="modal-body" onSubmit={submit}>
          <label className="field">
            <span>Filial nomi</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Masalan: Sag Chilonzor" maxLength={80} autoFocus required />
          </label>
          <label className="field">
            <span>Region</span>
            <select value={regionId} onChange={(e) => setRegionId(e.target.value)} required>
              {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <fieldset className="field">
            <span>Biznes bo'lim turi</span>
            <div className="seg">
              <label className={businessType === "SAG_BRANCH" ? "on" : ""}>
                <input type="radio" name="bt" checked={businessType === "SAG_BRANCH"} onChange={() => setBusinessType("SAG_BRANCH")} />
                SAG_BRANCH <small>SAG do'koni (HD)</small>
              </label>
              <label className={businessType === "INDEPENDENT_DEALER" ? "on" : ""}>
                <input type="radio" name="bt" checked={businessType === "INDEPENDENT_DEALER"} onChange={() => setBusinessType("INDEPENDENT_DEALER")} />
                INDEPENDENT_DEALER <small>Franshiza (F)</small>
              </label>
            </div>
          </fieldset>
          <label className="field">
            <span>Manzil <small>ixtiyoriy</small></span>
            <input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} placeholder="Shahar, ko'cha, uy" />
          </label>
          <fieldset className="field">
            <span>Do'kon funksiyasi</span>
            <div className="chips">
              {FUNCTIONS.map((f) => (
                <label key={f} className={functions.includes(f) ? "chip on" : "chip"}>
                  <input type="checkbox" checked={functions.includes(f)} onChange={() => toggle(f)} />
                  {FUNCTION_LABEL[f]}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="field">
            <span>Tavsif <small>ixtiyoriy</small></span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} rows={3} />
          </label>
          {error && <div className="notice warn" role="alert">{error}</div>}
          <div className="row-end branch-actions">
            <button type="button" className="ghost small" onClick={onClose} disabled={busy}>Bekor qilish</button>
            <button className="primary small" disabled={!valid || busy}>{busy ? "Yaratilmoqda…" : "Filial yaratish"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
