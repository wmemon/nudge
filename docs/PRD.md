# Product Requirements Document

**AI Accountability Companion**  
**iMessage MVP — Powered by LoopMessage**

| Field | Value |
|--------|--------|
| Version | 3.0 — LoopMessage Integration |
| Date | March 2026 |
| Status | Active |
| Classification | Confidential |

---

## 1. Executive Summary

The AI Accountability Companion is a proactive conversational AI that helps iPhone users stay consistent with personal goals and daily habits. The companion interacts through Apple’s native iMessage — the messaging interface users already check throughout the day — delivering a zero-friction experience with no separate app required.

This document (v3.0) defines the MVP built on **LoopMessage**, a third-party iMessage API service that enables two-way iMessage communication without requiring Apple Business Register approval or a dedicated Messaging Service Provider contract. This significantly reduces setup complexity and time-to-launch compared to the Apple Messages for Business route.

| Field | Value |
|--------|--------|
| Product Name | AI Accountability Companion |
| iMessage Provider | LoopMessage (loopmessage.com) |
| Sender Identity | Dedicated Sender Name (branded, not a phone number) |
| Target Platform | iPhone / Apple Devices — iOS 5.0+ |
| MVP Approach | Two-way iMessage via LoopMessage REST API |
| Onboarding Flow | User initiates via deep link → AI takes over |
| Starting Plan | LoopMessage Light ($59.99/mo) — upgrade to Regular as needed |
| Est. Dev Timeline | 3–4 weeks (no Apple approval dependency) |
| Est. Investment | $7,500 USD + LoopMessage subscription |
| Document Version | v3.0 — March 2026 |

---

## 2. Why LoopMessage for the MVP

### 2.1 LoopMessage vs Apple Messages for Business

The previous PRD version outlined the Apple Messages for Business (AMfB) path. After reviewing both options, LoopMessage is the superior choice for an MVP for the following reasons:

| Advantage | Detail |
|-----------|--------|
| No Apple approval | AMfB requires Apple to review and approve the messaging experience, a process that takes 3–6 weeks and can result in rejection. LoopMessage requires no Apple approval. |
| No live-agent requirement | Apple mandates that AMfB chatbots must include a live human agent. LoopMessage has no such restriction — a fully automated AI companion is permitted. |
| Direct REST API | LoopMessage exposes a simple HTTP API. Integration requires no MSP middleware, no enterprise contracts, and no complex provisioning. |
| Immediate sandbox | A free sandbox (5 contacts/day) is available immediately after signup for development and testing. |
| Indie/startup friendly | AMfB requires a registered legal entity with Apple. LoopMessage works for any developer or small startup. |
| Flexible pricing | Predictable monthly subscription with no per-message fees (unlike SMS/Twilio). Cost scales only when user volume grows. |
| Rich iMessage features | Typing indicators, read receipts, reactions, voice messages, attachments, group chats, and SMS/WhatsApp fallback are all supported. |
| Faster to market | 3–4 week dev timeline vs 7–9 weeks with AMfB. No external approval gates. |

---

## 3. Project Overview

### 3.1 Product Vision

The AI Accountability Companion reaches users inside Apple Messages — the app they already have open throughout the day. Rather than requiring users to open a separate productivity tool, the companion proactively check-ins, sends reminders, and maintains an ongoing supportive conversation via iMessage blue bubbles.

The experience should feel like texting a supportive friend, not using a productivity app.

### 3.2 Problem Statement

**Why existing habit apps fail**

- Users set up goals and forget to open the app again
- Push notifications from dedicated apps are ignored or disabled
- Complex dashboards and logs create friction that kills consistency
- No conversational warmth or genuine sense of accountability

The AI Accountability Companion solves this by living inside iMessage — where users already are.

### 3.3 Target Users

Primary audience: non-technical iPhone users who want accountability for habits but are overwhelmed by traditional productivity tools. They are motivated but inconsistent, and respond well to conversational nudges from a trusted contact.

| Segment | Example Use Cases |
|---------|---------------------|
| Fitness & Wellness | Daily gym check-ins, hydration reminders, step-count prompts |
| Productivity & Focus | Study accountability, deep work sessions, project milestone check-ins |
| Self-Improvement | Journaling, reading, meditation, gratitude practice |
| Daily Planning | Morning planning prompts, evening reflection, task prioritization |
| Recovery & Routine | Habit streaks, sobriety support, medication reminders |

---

## 4. LoopMessage Platform Details

### 4.1 How LoopMessage Works

LoopMessage provides a REST API that allows businesses to send and receive iMessage messages (blue bubbles) to any iPhone, iPad, or Mac user. Messages are delivered through a **Dedicated Sender Name** — a branded iMessage handle users see when the companion messages them.

1. User taps deep link — Opens a pre-composed iMessage to the companion’s Sender Name  
2. User sends first message — This constitutes consent and registers the contact in LoopMessage  
3. LoopMessage webhook fires — Inbound message is forwarded to the backend server  
4. Backend + AI engine — Processes the message, extracts intent, generates a response  
5. LoopMessage API call — Backend POSTs the reply to LoopMessage’s send API (`POST https://a.loopmessage.com/api/v1/message/send/`)  
6. Blue bubble delivered — Response appears in the user’s iMessage thread instantly  

### 4.2 API Integration

Sending a message via LoopMessage is a POST request per [LoopMessage send-message docs](https://docs.loopmessage.com/imessage-conversation-api/send-message.md). The API accepts phone number or iCloud email as the recipient (`contact` field):

- **POST** — `https://a.loopmessage.com/api/v1/message/send/`
- **Headers** — `Content-Type: application/json` | `Authorization: <Organization API Key>` (raw key; no `Bearer` prefix per [credentials](https://docs.loopmessage.com/imessage-conversation-api/credentials.md))
- **Body** — `{ "contact": "+13231112233", "text": "Good morning! Did you hit the gym today? 💪" }`
- **Response** — `200 OK` — request accepted for send (delivery is tracked via webhooks or status API, not implied by 200 alone)

The API supports rich message types including attachments, typing indicators, read status, audio, and reactions — all available to enhance the companion experience over time.

### 4.3 Pricing Tiers

LoopMessage charges a flat monthly fee with no per-message costs. The MVP will launch on the Light plan and upgrade to Regular as user volume grows:

| Tier | Price | Includes |
|------|-------|----------|
| **Sandbox** | Free | 5 contacts/day; testing only; end-to-end encryption |
| **Light** | $59.99/month | 300 contacts/day; 1,000 contacts/month; dedicated sender name; end-to-end encryption |
| **Regular** | $99.99/month | 1,000 contacts/day; 3,000 contacts/month; dedicated sender name; end-to-end encryption |

**Additional costs to note**

- Phone number add-on: available if a numeric sender is preferred over a named sender  
- SMS/WhatsApp fallback: optional add-on for reaching non-iPhone users  
- “Init conversations” feature: paid add-on (or free with organization verification) for outbound-first messaging  
- AI API costs (Claude/OpenAI): usage-based, separate from LoopMessage subscription  

---

## 5. Critical: Onboarding & Consent Flow

### 5.1 The User-Must-Initiate Rule

This is the most important product design constraint when building on LoopMessage. By default, the companion **cannot** send the first message to a new user cold. The user must send the first message, which acts as implicit consent.

**Design requirement: user-initiated onboarding**

LoopMessage’s platform — and iMessage itself — treats unsolicited first messages as potential spam. If enough recipients mark messages as “Report Junk”, the Sender Name can be permanently blocked by Apple with no refund. All user acquisition flows must therefore use **iMessage deep links** to prompt users to send the first message themselves.

### 5.2 Deep Link Onboarding Flow

A deep link is a URL that opens Apple Messages with a pre-composed message ready to send. This is the standard onboarding mechanism for LoopMessage-based products:

1. **Step 1** — User signs up on a web landing page or is referred via a link  
2. **Step 2** — They tap an iMessage deep link: `imessage://AI_SENDER_NAME?body=Hi+I+want+to+start`  
3. **Step 3** — Apple Messages opens with a pre-composed message to the Sender Name  
4. **Step 4** — User taps Send — this is their consent  
5. **Step 5** — Companion responds with a warm onboarding message and asks about their first goal  
6. **Step 6** — From this point, the companion can send proactive messages freely  

### 5.3 Example Onboarding Conversation

- **User (via deep link):** Hi, I want to start! 👋  
- **Companion:** Hey! Welcome 😊 I’m your accountability buddy. I’ll check in on your goals and keep you on track. What’s one habit you’d like to work on first?  
- **User:** I want to go to the gym every morning  
- **Companion:** Love it 💪 I’ll check in with you every morning. What time works best — 7am, 8am, or a different time?  
- **User:** 7am please  
- **Companion:** Done! I’ll message you at 7am tomorrow. Get some rest tonight 🌙  
- **Companion (next day, 7am):** Good morning ☀️ Did you make it to the gym today?  

### 5.4 Outbound-First Option (Future)

For future product phases where proactive outreach to new users is needed (e.g. CRM-driven campaigns), LoopMessage offers an “Init Conversations” feature. This requires either:

- Paying an add-on fee for the Init Conversations feature, **or**  
- Completing organization verification via a D-U-N-S Number + Apple business registration (free)  

Even with Init Conversations enabled, strict limits apply: a maximum of 50 new conversations per day, a minimum 10–15 minute interval between initiations, no links or attachments in the first message, and a minimum 30% reply rate must be maintained. **The MVP should not rely on this feature.**

---

## 6. Core MVP Features

### 6.1 Conversational Chat Interface

Users interact with the AI companion through natural language within Apple Messages. The companion understands goal-setting requests, responds with warmth, and maintains context within sessions. The AI engine (Claude or GPT) handles intent extraction and response generation.

### 6.2 Goal & Reminder Setup

Users define accountability goals using plain natural language. The AI extracts structured intent (frequency, time, habit type) and confirms the schedule before saving.

Examples:

- “Remind me to journal every night at 9pm”  
- “Check in with me about studying every weekday afternoon”  
- “Ask me if I drank enough water at the end of each day”  

### 6.3 Scheduled AI Check-ins

After a user has initiated a conversation and set a goal, the companion proactively sends check-in messages at the configured times via the LoopMessage API. These appear in the user’s existing iMessage thread.

- Morning check-ins and daily habit reminders  
- Evening reflection prompts  
- Weekly streak summaries  
- Gentle re-engagement after missed days  

### 6.4 Accountability Feedback

The system tracks user responses and adapts the companion’s messaging tone over time:

- “Great job — 5 days in a row! You’re building something real 🔥”  
- “Looks like you’ve missed a few days. Want to reset your goal or adjust the schedule?”  
- “You’re back! Let’s get that streak going again 💪”  

### 6.5 AI Companion Personality

The companion has a defined, consistent personality to build user trust and warmth:

- Warm, encouraging, and non-judgmental in all interactions  
- Celebrates wins without being patronising  
- Re-engages after missed days without guilt or shaming  
- Adapts message style based on engagement patterns  
- Optional light mascot / character identity for the Sender Name branding  

---

## 7. Technical Architecture

### 7.1 System Components

| Component | Role |
|-----------|------|
| LoopMessage API | iMessage gateway — handles inbound webhook delivery and outbound message dispatch via REST API |
| Dedicated Sender | LoopMessage Sender Name — branded identity users see in their iMessage thread |
| Backend Server | **TypeScript / Node.js** service (**Fastify**) — webhook handler, session management, scheduler engine; deployed on **Render** (see [ADR 001](./adr-001-backend-mvp-architecture.md)) |
| AI Engine | **LLM APIs** — **OpenAI** primary, **Anthropic** fallback; intent extraction, response generation, personality and tone management |
| Database | **Supabase PostgreSQL** — user profiles, goal configs, message history, session state |
| Scheduler | **BullMQ** (Redis-backed) — triggers proactive check-ins at configured times |
| Cache / queue | **Redis** — durable jobs, scheduling primitives, and rate limits (not only ephemeral session cache) |
| Deep Link Generator | Utility to produce onboarding URLs: `imessage://<SENDER>?body=<TEXT>` |
| Marketing + utility web | **Vercel** — landing, deep links, export/delete OTP forms; talks to backend over HTTPS (see [ADR 001](./adr-001-backend-mvp-architecture.md)) |

> **Note:** Concrete runtime, hosting, and vendor choices follow [ADR 001](./adr-001-backend-mvp-architecture.md) and the clarification/workshop records; this table summarizes logical components.

### 7.2 Key Technical Constraints

- **Contact registration:** A contact only becomes messageable after they have sent the first message. The backend must handle the webhook for that first inbound message before it can dispatch any outbound messages.  
- **Session persistence:** Conversation context must be stored per-user in the database as LoopMessage is stateless.  
- **Scheduler timing:** Proactive messages are dispatched by the backend scheduler calling the LoopMessage API — there is no native scheduling feature in LoopMessage itself.  
- **Reply rate monitoring:** The system should log response rates. If reply rates drop below 30%, outbound cadence should be reduced to protect Sender Name reputation.  
- **Fallback handling:** LoopMessage supports SMS/WhatsApp fallback as an add-on. This can be enabled for users who turn off iMessage or upgrade to Android.  
- **Sandbox for development:** Use LoopMessage’s free Sandbox environment (5 contacts/day) during development. Upgrade to Light plan for beta testing.  

---

## 8. Development Timeline

Estimated timeline: **3–4 weeks**. No Apple approval dependency — this is a direct API integration.

| Phase | Deliverables |
|-------|----------------|
| **Week 1** | LoopMessage account setup and Sandbox credentials; backend scaffolding; webhook integration for inbound messages; deep link onboarding flow design |
| **Week 2** | AI engine integration (intent extraction + response generation); goal creation and session persistence; conversational flow development and personality tuning |
| **Week 3** | Proactive check-in scheduler; outbound message dispatch via LoopMessage API; accountability feedback logic; message history tracking |
| **Week 4** | End-to-end testing with real iMessage contacts; edge case handling; beta user onboarding; upgrade from Sandbox to Light plan; production deployment |

Compared to the AMfB approach, this saves 3–5 weeks: no Apple Business Register application, no MSP contract negotiation, no Apple experience review. Development starts on Day 1 and ships to real users within 4 weeks.

---

## 9. Estimated Investment

### 9.1 Development Cost

| Line Item | Scope |
|-----------|--------|
| LoopMessage API Integration | Webhook setup, inbound/outbound message routing, Sender Name configuration |
| Deep Link Onboarding Flow | Landing page or referral link + deep link generation + first-message handling |
| AI Engine Integration | LLM API setup, intent extraction, personality configuration, session management |
| Scheduler & Proactive Messaging | Cron-based job queue, check-in dispatch, reply tracking |
| Database & State Management | User profiles, goal configs, conversation history, Redis caching |
| QA & Testing | Sandbox testing, real-contact beta, edge case coverage |
| Branding Assets | Sender Name identity, companion personality guidelines, tone document |

**Total Development Investment: $7,500 USD**

### 9.2 Ongoing Operational Costs

| Item | Cost Estimate |
|------|-----------------|
| LoopMessage Light plan | $59.99/month — 300 contacts/day, 1k/month (MVP launch) |
| LoopMessage Regular plan | $99.99/month — 1k/day, 3k/month (scale-up) |
| AI API (Claude/GPT) | Usage-based — approx. $0.002–0.01 per conversation turn depending on model |
| Server hosting | ~$20–50/month (cloud VM + database) |

---

## 10. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Sender Name blocked by Apple | Only send to users who have initiated a conversation. Monitor reply rates. Never send promotional or spammy content. Use warm, personalised messages. |
| Low deep-link conversion | Optimise onboarding copy and CTA. A/B test the pre-composed message text. Offer value clearly before asking user to tap the link. |
| User reply rate drops below 30% | Build in frequency controls and skip rules. Allow users to pause or reduce cadence. Monitor rates weekly and throttle if declining. |
| AI response quality issues | Implement prompt engineering guardrails. Log and review edge-case responses during beta. Add fallback responses for unrecognised input. |
| LoopMessage service disruption | Monitor LoopMessage uptime. Queue outgoing messages with retry logic. Communicate delays to users transparently. |
| Scaling beyond Light plan | Upgrade to Regular plan when contacts/day exceed 300. Model cost increases into pricing at 3,000+ active users/month. |

---

## 11. Future Roadmap

| Phase | Description |
|-------|----------------|
| Phase 2 | SMS/WhatsApp fallback via LoopMessage add-on — reach non-iPhone users |
| Phase 3 | Rich iMessage interactions — quick-reply buttons, reaction-based confirmations, image/audio messages |
| Phase 4 | Habit analytics — streak tracking, weekly summaries, goal completion rates |
| Phase 5 | Outbound-first campaigns — enable Init Conversations feature with organization verification |
| Phase 6 | Group accountability — shared goals using LoopMessage group chat support |
| Phase 7 | Android / web companion — mirror experience via WhatsApp or web chat interface |

---

## 12. Next Steps

**Action items to start immediately**

- Confirm product scope and approve this PRD  
- Sign up for LoopMessage account at dashboard.loopmessage.com  
- Purchase a Dedicated Sender Name and obtain API credentials  
- Enable Sandbox environment for development (free, 5 contacts/day)  
- Define Sender Name branding and companion personality guidelines  
- Begin backend development sprint — target: production-ready in 4 weeks  
- Build and test onboarding deep link flow with internal beta testers  
- Upgrade to LoopMessage Light plan when ready for external beta  

Development can begin within 24 hours of LoopMessage account setup. There are no external approval gates. The estimated time from kick-off to live users is 4 weeks.

---

## Source

Converted from `docs/prd.docx` (Version 3.0, March 2026). If the Word file is updated, regenerate or merge changes into this markdown copy.
