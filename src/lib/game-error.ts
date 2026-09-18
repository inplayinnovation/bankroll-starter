export class GameError extends Error {
  constructor(
    public code: string,
    public status: number,
    message = code,
  ) {
    super(message);
  }
}
