export interface SkillRow {
  id: string;
  name: string;
  source: string;
  path: string;
  description: string | null;
  installed_at: number;
}

export interface SkillMeta {
  name: string;
  description: string;
  path: string;
}
