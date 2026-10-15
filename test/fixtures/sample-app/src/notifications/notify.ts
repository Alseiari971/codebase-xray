export interface Notifier {
  send(message: string): void;
}

export function notifyAll(notifiers: Notifier[], message: string): void {
  for (const notifier of notifiers) notifier.send(message);
}
