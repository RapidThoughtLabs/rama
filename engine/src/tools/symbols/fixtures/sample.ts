export type LanguageModel = string;
export type Shape = { width: number; height: number };

export type User = {
  id: string;
  name: string;
};

export enum Status {
  Active = "active",
  Inactive = "inactive",
}

export const fetchUser = async (id: string): Promise<User> => {
  return { id, name: "test" };
};

export async function resolveModel(name: string): Promise<LanguageModel> {
  return name;
}

export class AgentRun {
  private model: LanguageModel;

  constructor(model: LanguageModel) {
    this.model = model;
  }

  start(input: string): void {
    console.log(input);
  }

  async step(ctx: unknown): Promise<void> {
    console.log(ctx);
  }
}
