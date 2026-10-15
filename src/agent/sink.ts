/** Para onde vão os eventos de um turno: o terminal (`ui`) ou a janela do app desktop. */
export interface TurnSink {
  turnStart(): void;
  turnEnd(ok?: boolean): void;
  text(chunk: string): void;
  textEnd(): void;
  thinking(text: string): void;
  toolStart(id: string, name: string, input: unknown): void;
  toolEnd(id: string, isError: boolean, output?: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}
