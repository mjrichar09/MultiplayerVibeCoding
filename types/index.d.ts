// What `multiplayer board --json` reports, as the team panel keeps it.
export type BoardClaim = {
  slug: string;
  task: string;
  paths: string[];
  branch: string | null;
  device: string | null;
  started: string;
  updated: string;
  stale: boolean;
  mergedPr: number | null;
};

export type BoardMember = { user: string; claims: BoardClaim[] };

export type Board = {
  setUp: boolean;
  me?: string | null;
  members?: BoardMember[];
  notes?: { user: string; title: string; created: string }[];
  handoffs?: { from: string; to: string[]; title: string; created: string }[];
  votes?: { id: string; title: string; kind: 'pick' | 'decide'; urgent: boolean; by: string; state: 'open' | 'counted'; waitingOn: string[] }[];
};

declare module 'claude-code' {
  interface PluginState {
    multiplayer: { board: Board | null };
  }
}
