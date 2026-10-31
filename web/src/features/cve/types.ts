// Bentuk data Cek CVE dari backend (/api/cve).
export type Verdict = 'rentan_tanpa_patch' | 'rentan_patch_tersedia' | 'tidak_diketahui' | 'aman' | 'tidak_terdampak';
export interface PkgStatus { status: string; fixed: string }
export interface PkgVerdict { name: string; status: string; fixed: string; installed: string | null; verdict: Verdict; text: string }
export interface ServerVerdict {
  server_id: number; name: string; host: string; hasAgent: boolean; publicHost: boolean | null; os: string | null; release: string | null; kernel: string | null;
  verdict: Verdict; packages: PkgVerdict[]; note: string | null; kernelPkg: boolean;
}
/** resmi = teks yang diterbitkan Ubuntu; umum = langkah wajar untuk jenis masalah ini, bukan penawar khusus CVE-nya. */
export interface Advice { kind: 'resmi' | 'umum'; title: string; text: string; link?: string }
export interface CveLookup {
  id: string; found: boolean; sources: { ubuntu: string; osv: string }; summary: string; description: string; published: string | null; updated: string | null; priority: string; cvss: number | null; vector: string | null;
  kev: boolean | null; mitigation: string; notices: string[]; references: string[]; matrix: Array<{ name: string; statuses: Record<string, PkgStatus> }>; matrixTotal: number; matrixReleases: string[];
  releaseLabels: Record<string, string>; servers: ServerVerdict[]; advice: Advice[]; watching: boolean;
}
export interface CveWatch { cve: string; created: number; last_check: number | null; notified: number | null; state: Array<{ key: string; value: string }> }
