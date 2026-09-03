/**
 * Full-fidelity spreadsheet calculation for Squisq data cards.
 *
 * IronCalc is deliberately a host capability: Squisq keeps its wasm backend
 * behind an optional subpath and asks EditorShell consumers for an async
 * factory. The static `?url` import only makes Vite publish the wasm alongside
 * the UI bundle; neither the adapter nor the ~2 MB binary is loaded until an
 * XLSX-backed data card actually opens a formula session.
 *
 * If the dynamic import or wasm initialization fails, EditorShell falls back
 * to Squisq's in-house calculation tier, so a missing engine never makes the
 * document itself unavailable.
 */

import type { CalcEngineFactory } from '@bendyline/squisq-editor-react';
import ironCalcWasmUrl from '@ironcalc/wasm/wasm_bg.wasm?url';

export const ironCalcEngineFactory: CalcEngineFactory = async (config) => {
  const { createIronCalcEngine } = await import('@bendyline/squisq-calc/ironcalc');
  return createIronCalcEngine({ ...config, wasmSource: ironCalcWasmUrl });
};
