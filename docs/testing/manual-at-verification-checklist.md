# Manual Assistive Technology Verification Checklist

**Version:** 1.0  
**Owner:** Accessibility, QA  
**Executed at:** Each phase gate (Phase 1, Phase 2, Phase 3)

This checklist must be executed and signed off by a QA engineer using a supported screen reader before promoting to the next phase. All checks must be PASS for the gate to clear.

---

## Prerequisites

| Item | Detail |
|------|--------|
| Screen readers | NVDA + Chrome (Windows), JAWS + Chrome (Windows), VoiceOver + Safari (macOS/iOS) |
| Test environment | Staging only — synthetic travelers (BR-18) |
| Browsers | Chrome latest, Safari latest |
| Viewport | 1280×800 desktop, 375×667 mobile (iPhone 13 viewport) |
| Themes | Both light and dark themes must be tested |

---

## 1. Search Journey

### 1.1 Page structure and landmarks

| # | Step | Expected | Pass / Fail | Notes |
|---|------|----------|-------------|-------|
| 1.1.1 | Land on `/en/search` with screen reader active | Page title is announced ("Search — Travel Platform") | | |
| 1.1.2 | List landmarks (NVDA: `Insert+F7`, VO: `Control+Option+U`) | `main`, `header`, `nav`, `footer` all present | | |
| 1.1.3 | Navigate to search form heading | Heading level 1 announces the search form context | | |

### 1.2 Search form fields

| # | Step | Expected | Pass / Fail | Notes |
|---|------|----------|-------------|-------|
| 1.2.1 | Tab to "From / Origin" field | Field label announced; "required" announced | | |
| 1.2.2 | Type "JFK" and Tab away | No announcement of irrelevant state changes | | |
| 1.2.3 | Type "JFKK" (invalid IATA) and submit | Error message announced via live region; field identified by label | | |
| 1.2.4 | Tab to departure date field | Date input label and format hint ("YYYY-MM-DD") announced | | |
| 1.2.5 | Enter a past date and submit | Validation error names the "Departure date" field explicitly | | |

### 1.3 Search results

| # | Step | Expected | Pass / Fail | Notes |
|---|------|----------|-------------|-------|
| 1.3.1 | Submit a valid search | "Searching…" or loading state announced via live region | | |
| 1.3.2 | Results appear | "N results found" or similar announced; results are navigable as a list | | |
| 1.3.3 | Navigate first result card | Supplier name, price, currency, and validity all readable without visual scan | | |
| 1.3.4 | Zero availability result | Empty state heading and alternative-date suggestions announced | | |

---

## 2. Checkout Journey

### 2.1 Price and freshness information

| # | Step | Expected | Pass / Fail | Notes |
|---|------|----------|-------------|-------|
| 2.1.1 | Land on checkout with stale offer | Freshness/indicative label announced before price | | |
| 2.1.2 | Price increase modal appears | Modal role announced; new price and acceptance buttons readable | | |
| 2.1.3 | Focus management on modal open | Focus moves to modal and is trapped | | |
| 2.1.4 | Accept price change and close modal | Focus returns to logical position in the checkout flow | | |

### 2.2 Payment step

| # | Step | Expected | Pass / Fail | Notes |
|---|------|----------|-------------|-------|
| 2.2.1 | Navigate to payment step | "Payment details" heading or section announced | | |
| 2.2.2 | Tab into Stripe iframe | Screen reader enters iframe; card number field label announced | | |
| 2.2.3 | Fill card number (test card) | Input acknowledged; no PAN value announced back | | |
| 2.2.4 | Submit payment | "Processing payment" or similar progress state announced | | |
| 2.2.5 | PENDING state shown | Booking status "Pending" announced | | |
| 2.2.6 | CONFIRMED state shown | "Booking confirmed" announcement via live region | | |

### 2.3 Error states

| # | Step | Expected | Pass / Fail | Notes |
|---|------|----------|-------------|-------|
| 2.3.1 | Payment declined | Decline reason announced; retry option accessible by keyboard | | |

---

## 3. Cancellation Journey

| # | Step | Expected | Pass / Fail | Notes |
|---|------|----------|-------------|-------|
| 3.1 | Navigate to confirmed booking | Booking summary readable; status "Confirmed" announced | | |
| 3.2 | Tab to "Cancel Booking" button | Button label announced with no ambiguity | | |
| 3.3 | Activate cancel button | Confirmation dialog announced; dialog role present | | |
| 3.4 | Focus management on dialog open | Focus moves to dialog; backdrop not navigable | | |
| 3.5 | Confirm cancellation | "Booking cancelled" status announced via live region | | |
| 3.6 | Navigate audit trail | Cancellation event readable in activity log list | | |
| 3.7 | Disallowed cancellation error | 409-derived error lists permitted transitions audibly | | |

---

## 4. Assistant (Chat) Journey

### 4.1 Chat interface

| # | Step | Expected | Pass / Fail | Notes |
|---|------|----------|-------------|-------|
| 4.1.1 | Land on `/en/assistant` | Page title announced; chat region identified as a `log` or labelled region | | |
| 4.1.2 | Tab to message input | Label "Message" or equivalent announced | | |
| 4.1.3 | Tab to Send button | "Send message" button label announced | | |

### 4.2 Message announcement

| # | Step | Expected | Pass / Fail | Notes |
|---|------|----------|-------------|-------|
| 4.2.1 | Send a message | User message confirmed by screen reader | | |
| 4.2.2 | Assistant responds | New assistant message announced via polite live region | | |
| 4.2.3 | Rapid streaming tokens | Announcements are per-message, not per-token (no flooding) | | |
| 4.2.4 | Second message exchange | Only the NEW message is announced, not the full transcript | | |

### 4.3 Offer cards in chat

| # | Step | Expected | Pass / Fail | Notes |
|---|------|----------|-------------|-------|
| 4.3.1 | Offer card appears in chat | Card role ("article" or labelled region) announced | | |
| 4.3.2 | Navigate offer card | Supplier, price, currency readable in order | | |
| 4.3.3 | Illustrative card present | "Illustrative — not bookable" label announced before price | | |
| 4.3.4 | Illustrative card — no checkout affordance | No "Book" button present or reachable by Tab | | |

### 4.4 Cost ceiling

| # | Step | Expected | Pass / Fail | Notes |
|---|------|----------|-------------|-------|
| 4.4.1 | Cost ceiling reached | Refusal message announced; traditional search link accessible | | |

---

## 5. Profile and Account

| # | Step | Expected | Pass / Fail | Notes |
|---|------|----------|-------------|-------|
| 5.1 | Land on `/en/account` | Account heading announced | | |
| 5.2 | Navigate booking history | List of bookings traversable; each status readable | | |
| 5.3 | Open booking detail | All booking facts readable without visual context | | |

---

## 6. Itinerary Page

| # | Step | Expected | Pass / Fail | Notes |
|---|------|----------|-------------|-------|
| 6.1 | Land on `/en/itinerary` | Itinerary heading and item count announced | | |
| 6.2 | Navigate itinerary items | Each item has a unique, descriptive label | | |
| 6.3 | Remove item | Confirmation prompt present; removal announced | | |

---

## 7. Downloadable Trip Document

| # | Step | Expected | Pass / Fail | Notes |
|---|------|----------|-------------|-------|
| 7.1 | Find download link | "Download trip document" link announced; opens in new tab warned if applicable | | |
| 7.2 | Open PDF in screen reader | PDF opens without error; title announced | | |
| 7.3 | Navigate PDF headings | Headings present for each booking section | | |
| 7.4 | Read flight details | Airline, flight number, departure, arrival all readable in order | | |
| 7.5 | Multi-leg itinerary | Each leg section is separately identified and navigable | | |

---

## 8. Locale and RTL (Arabic)

| # | Step | Expected | Pass / Fail | Notes |
|---|------|----------|-------------|-------|
| 8.1 | Switch locale to Arabic | `html[dir="rtl"]` set; screen reader announces in correct reading direction | | |
| 8.2 | Navigate search form in RTL | Tab order follows visual RTL layout | | |
| 8.3 | Currency display in Arabic | Price and currency formatted per Arabic conventions; readable | | |

---

## 9. Mobile (VoiceOver + Safari)

| # | Step | Expected | Pass / Fail | Notes |
|---|------|----------|-------------|-------|
| 9.1 | Search on iPhone viewport | Touch navigation reaches all form elements | | |
| 9.2 | Swipe through search results | Each card accessible by swipe; no skip regions | | |
| 9.3 | Complete checkout on mobile | Payment iframe accessible; keyboard dismissal does not break flow | | |

---

## Sign-off

**Executed by:** ___________________________  
**Date:** ___________________________  
**Screen readers used:** ___________________________  
**Environment (staging URL):** ___________________________  
**Run ID:** ___________________________

| Section | Result | Blocking Issues | Resolved By |
|---------|--------|-----------------|-------------|
| 1. Search | PASS / FAIL | | |
| 2. Checkout | PASS / FAIL | | |
| 3. Cancellation | PASS / FAIL | | |
| 4. Assistant | PASS / FAIL | | |
| 5. Profile | PASS / FAIL | | |
| 6. Itinerary | PASS / FAIL | | |
| 7. Trip Document | PASS / FAIL | | |
| 8. Locale/RTL | PASS / FAIL | | |
| 9. Mobile | PASS / FAIL | | |

**Overall Gate Decision:** PASS / FAIL  
**Approver:** ___________________________  
**Approver Date:** ___________________________

---

*Any FAIL finding is a blocking issue for phase promotion. Open a P1 accessibility issue in the issue tracker and link it here before re-executing.*
