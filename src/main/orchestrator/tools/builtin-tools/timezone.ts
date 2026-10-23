import { resolveChatContextTimezone } from "../../../chat/chat-time-context";

type TimezoneReader = () => string | undefined;
const timezoneConfiguration: { reader: TimezoneReader | null } = { reader: null };
export function setUserTimezoneConfig(timezoneGetter: () => string | undefined): void {
  timezoneConfiguration.reader = timezoneGetter;
}
export function currentUserTimezone(): string {
  const readTimezone = timezoneConfiguration.reader;
  return resolveChatContextTimezone(readTimezone?.());
}
