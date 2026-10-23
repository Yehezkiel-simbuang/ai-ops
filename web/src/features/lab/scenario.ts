// State skenario eksperimen: daftar aksi (rekomendasi + komponen), beban, durasi, gangguan. Reducer murni agar mudah diuji.
import type { ComponentId, LabAction, LabEstimate, LabFailure, LabLoad, LabParam, LabProject, ParamValue, Scenario } from './types';

/** Parameter penentu "target" tiap komponen; harus sama dengan actionKey di server (simulator/src/components.js). */
const TARGET: Partial<Record<ComponentId, string>> = { replica: 'db', hadb: 'db', dbsplit: 'workload', queue: 'workload', scaleup: 'pool', ssd: 'disk' };

/** Kunci unik satu aksi komponen: komponen yang sama dengan target yang sama menggantikan, bukan menumpuk. */
export function componentKey(component: ComponentId, params: Record<string, ParamValue>): string {
  const t = TARGET[component];
  return t ? `${component}:${params[t]}` : component;
}

export const defaultParams = (params: LabParam[]): Record<string, ParamValue> => Object.fromEntries(params.map((p) => [p.key, p.default]));

export const recAction = (id: string): LabAction => ({ kind: 'rec', id });
export const componentAction = (component: ComponentId, params: Record<string, ParamValue>): LabAction => ({ kind: 'component', component, params });

export const actionKeyOf = (a: LabAction): string => (a.kind === 'rec' ? `rec:${a.id}` : componentKey(a.component, a.params));

export type Start = 'rec' | 'now';

export function initialScenario(p: LabProject, start: Start = 'rec'): Scenario {
  return {
    project: p.id, actions: start === 'rec' ? p.recommendedIds.map(recAction) : [], load: structuredClone(p.load), seconds: p.seconds,
    faults: !p.faultsAssumed && p.faults.length > 0,   // gangguan yang benar-benar terjadi menyala otomatis; yang hanya asumsi, tidak
    failure: null
  };
}

export type ScenarioEvent =
  | { type: 'init'; project: LabProject; start: Start }
  | { type: 'toggleRec'; id: string }
  | { type: 'setComponent'; component: ComponentId; params: Record<string, ParamValue> }
  | { type: 'removeAction'; key: string }
  | { type: 'clearActions' }
  | { type: 'setEstimates'; estimates: LabEstimate[] }
  | { type: 'setLoad'; load: LabLoad }
  | { type: 'setSeconds'; seconds: number }
  | { type: 'setFaults'; on: boolean }
  | { type: 'setFailure'; failure: LabFailure | null }
  | { type: 'restore'; scenario: Scenario };

export function scenarioReducer(s: Scenario | null, e: ScenarioEvent): Scenario | null {
  if (e.type === 'init') return initialScenario(e.project, e.start);
  if (e.type === 'restore') return structuredClone(e.scenario);
  if (!s) return s;
  switch (e.type) {
    case 'toggleRec': {
      const has = s.actions.some((a) => a.kind === 'rec' && a.id === e.id);
      return { ...s, actions: has ? s.actions.filter((a) => !(a.kind === 'rec' && a.id === e.id)) : [...s.actions, recAction(e.id)] };
    }
    case 'setComponent': {
      const next = componentAction(e.component, e.params), key = actionKeyOf(next);
      const exists = s.actions.some((a) => actionKeyOf(a) === key);
      return { ...s, actions: exists ? s.actions.map((a) => (actionKeyOf(a) === key ? next : a)) : [...s.actions, next] };
    }
    case 'removeAction': return { ...s, actions: s.actions.filter((a) => actionKeyOf(a) !== e.key) };
    case 'clearActions': return { ...s, actions: [] };
    case 'setEstimates': return { ...s, estimates: e.estimates };
    case 'setLoad': return { ...s, load: e.load };
    case 'setSeconds': return { ...s, seconds: e.seconds };
    case 'setFaults': return { ...s, faults: e.on };
    case 'setFailure': return { ...s, failure: e.failure };
  }
}

export const totalRps = (l: LabLoad): number => (l.users * l.rpu) / 60;
export const peakRps = (l: LabLoad): number => totalRps(l) * (l.spike.on ? l.spike.mult : 1);
/** Harus sama dengan MAX_PEAK_RPS di server (lab/types.ts). */
export const MAX_PEAK_RPS = 4000;
