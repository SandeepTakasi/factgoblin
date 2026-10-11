export type AnchorType =
  | 'path' // file or directory in the repo
  | 'script' // package.json script name
  | 'make_target'
  | 'just_recipe'
  | 'package' // workspace package or dependency name
  | 'symbol' // function/class/const that should exist
  | 'api' // symbol the file tells agents to USE (also checked for deprecation)
  | 'command' // anything else runnable; LLM-verified
  | 'other';

export interface Anchor {
  type: AnchorType;
  value: string;
}

/** fact = checkable statement; the rest are never reported as stale. */
export type ClaimKind = 'fact' | 'example' | 'preference' | 'policy';

export interface Claim {
  id: string;
  file: string; // repo-relative instruction file
  line: number;
  quote: string; // exact text from the file
  statement: string; // what is being asserted, in plain words
  kind: ClaimKind;
  anchors: Anchor[];
}

export type CheckStatus = 'pass' | 'fail' | 'unknown';

export interface CheckResult {
  anchor: Anchor;
  status: CheckStatus;
  detail: string;
}

export type Severity = 'high' | 'medium' | 'low';

export interface Evidence {
  path: string;
  line?: number;
  note: string;
}

export interface Finding {
  claim: Claim;
  severity: Severity;
  reason: string;
  evidence: Evidence[];
  fix?: { old: string; new: string };
}

export interface InstructionFile {
  path: string; // repo-relative, canonical
  aliases: string[]; // symlinks / identical copies that point at the same content
}
