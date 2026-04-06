// E-RECIPIENT — canonical identity record for a LoopMessage contact.
// Owned exclusively by the identity-recipient module (data-model-and-ownership §4).

export interface Recipient {
  id: string
  handle: string           // E.164 phone or iCloud email (LoopMessage "contact")
  firstSeenAt: Date
  onboardingComplete: boolean
  quietHoursTz: string | null
  globallyPaused: boolean
  createdAt: Date
  updatedAt: Date
}
