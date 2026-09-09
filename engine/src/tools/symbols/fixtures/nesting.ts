export class Greeter {
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  greet(): string {
    const inner = () => "hello";
    return `${inner()} ${this.name}`;
  }

  async farewell(): Promise<string> {
    return `goodbye ${this.name}`;
  }
}

export function standalone() {
  return 42;
}
