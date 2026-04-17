## Triangle Pattern

Triangle is Structa's synthesis primitive.

Gesture:
- double-side once on content to arm point A
- double-side on different content to open triangle
- hold `ptt` to speak the angle
- release to synthesize a derived signal

Rules:
- double-side on the same armed item dismisses triangle
- back from the triangle overlay returns to the armed slot
- shake during the overlay clears triangle and returns home
- triangle persists across navigation and project switching

Outputs:
- one derived `signal` lands in KNOW with `source: triangle`
- optional follow-up question is added as an open ask
- triangulated signals are marked with `▼` in KNOW

Design intent:
- two points plus one angle produce one new signal
- the user's spoken angle is the lens, not optional flavor
- triangle is visible as a bottom-left indicator on every screen except the live camera
