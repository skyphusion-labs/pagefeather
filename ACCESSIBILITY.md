# Accessibility

Pagefeather is a framework for WordPress and WooCommerce on Cloudflare. You run it in your own Cloudflare account. We also keep a public marketing site at [www.pagefeather.dev](https://www.pagefeather.dev/).

We want people with disabilities, and people who use assistive technology, to read this repository, use the marketing site, and contribute. This document says what we aim for, what contributors should do, how to report a barrier, and what we do not yet claim.

This file follows the shape of the [open-source accessibility toolkit ACCESSIBILITY.md](https://github.com/open-source-accessibility/accessibility-toolkit/blob/main/ACCESSIBILITY.md). The words are adapted for Pagefeather.

## Priorities

- **Accessibility target.** We work toward [WCAG 2.2 Level AA](https://www.w3.org/TR/WCAG22/). That target guides our work. It is not a claim of verified conformance. We will only claim conformance after an evaluation that names the scope, the date, the method, and the evaluator.
- **Keyboard support.** Every interactive control we ship must be reachable and usable with a keyboard alone. Focus must be visible. Tab order must make sense.
- **Screen reader support.** Content should use semantic HTML and a clear heading order so VoiceOver, NVDA, JAWS, TalkBack, and similar tools can navigate it.
- **Readable content.** Docs use Simplified Technical English: short sentences, plain words, one idea per sentence. Prefer descriptive link text, enough color contrast, real lists, and meaningful alternative text.
- **Language.** Mark the language of a page or a passage in code so assistive technology can pronounce it correctly.

## Scope

Three surfaces matter for accessibility here:

1. **This repository's docs** (`README.md`, `docs/`, issue and pull request text). Readers meet these first.
2. **The marketing site** at www.pagefeather.dev (theme under `site/` when present). Guests read product pages there.
3. **Sites you deploy with Pagefeather.** Those sites run WordPress and, when chosen, WooCommerce. Upstream WordPress and WooCommerce own much of that UI. We own the engine, the deploy path, and the default theme or content we ship. Limits of the engine (memory, cache, login) can affect how a site behaves under assistive technology. Those product limits stay on [Known limitations](docs/guide/limits.md).

## Contributor expectations

If you change user-facing UI or content, please follow these rules so we do not make access worse.

### Testing

- For UI changes, run an automated accessibility check (for example [axe DevTools](https://www.deque.com/axe/devtools/) or the [GitHub Accessibility Scanner](https://github.com/github/accessibility-scanner)).
- Do at least one keyboard-only pass on interactive UI:
  - Tab order is logical. There are no jumps and no traps. Every control is reachable.
  - Focus is always visible and has enough contrast.
  - Actions work with Tab, Shift+Tab, Enter, Space, and arrow keys where those keys are expected.
  - You can move into and out of modals, menus, popovers, and editors.
- Spot-check screen reader behavior for new components or large content changes:
  - Headings and landmarks work for navigation.
  - Controls have clear accessible names that match their purpose.
  - Custom controls expose role, name, value, and state (for example expanded or selected).
  - Lists are announced as lists.
  - Errors, async status, and validation updates are announced when needed (for example with ARIA live regions).
  - Reading order is logical.

### Documentation and content

- Use a logical heading hierarchy. Do not skip levels.
- Use real list elements, not lines that only look like a list.
- Use unique, descriptive link text. Avoid "click here" and "read more".
- Provide meaningful alternative text for images. See the [W3C alt Decision Tree](https://www.w3.org/WAI/tutorials/images/decision-tree/).
- For complex images or diagrams, put a text alternative nearby.
- For tables, provide column and row headers.
- For videos, provide captions and a transcript.
- Do not use color as the only way to convey meaning.
- Content must reflow without loss of information. Check at 200% zoom and at a narrow width.
- Docs follow Simplified Technical English. Do not use an em dash or an en dash. Use a comma, a semicolon, parentheses, or two hyphens (`--`).

### CI

This repository does not yet block pull requests on an accessibility scanner. CI checks docs links, syntax, and other gates listed in [CONTRIBUTING.md](CONTRIBUTING.md). If we add an accessibility scan later, this section will name it. Until then, do the manual checks above for user-facing changes. If a known violation must wait, say why in the pull request.

## Reporting accessibility issues

If you hit a barrier, please tell us. We treat accessibility reports as expertise, not complaints.

1. **Open a GitHub issue** with the [bug template](https://github.com/skyphusion-labs/pagefeather/issues/new?template=bug.yml). Put `accessibility:` at the start of the title so we can find it.
2. Include, when you can:
   - What you were trying to do, and what went wrong.
   - The page URL (docs path, pagefeather.dev URL, or a deployed `workers.dev` site).
   - Steps to reproduce.
   - Your operating system, browser, and assistive technology (with versions).
   - A screen recording or screenshot, if you are comfortable sharing one.
   - Severity, using the labels below. Maintainers may change the severity at triage. You do not have to set it.

Do not put secrets, passwords, or private site tokens in the issue. Do not disclose a diagnosis. We will not ask for one.

### Severity

- **Critical:** You cannot complete a core task (for example, you cannot read the Start here page at all, or you cannot reach wp-admin with a keyboard).
- **Serious:** Significant difficulty, but a workaround exists.
- **Moderate:** Annoyance or an inconsistent experience.
- **Minor:** Small issue with little effect on use.

### How we respond

- We acknowledge the report promptly, with respect.
- We do not require a diagnosis or other personal information.
- We explain next steps, known limits, and dependencies.
- Where we can, we offer a workaround while a fix is in progress.
- We update the issue when status or timing changes (for example, "tracking in #123").
- We may ask you to confirm that a fix removes the barrier before we close the issue.
- We thank you for helping improve the project.

### Resolution expectations

This project is young. We still set targets so reporters know what to expect. After triage we assign a severity, an owner, and a target date.

- **Critical:** Resolve within 30 days.
- **Serious:** Resolve within 60 days.
- **Moderate:** Resolve within 90 days.
- **Minor:** Resolve within 90 days.

These targets start when the issue is opened. If we cannot meet a target, we explain the delay, share any workaround, and give a new date. A fix that needs an upstream WordPress or WooCommerce change may wait on that project. We say so in the issue.

## Ownership and maintenance

Accessibility is owned by the **Pagefeather maintainers**.

### Responsibilities

The accessibility owner is responsible for:

- Triaging accessibility reports.
- Tracking accessibility work and known barriers.
- Sharing status updates and escalating unresolved risks to maintainers.
- Keeping this document current.

Review this file when the marketing site theme changes, when Start here or other public docs change in a large way, or at least once a year. If ownership moves, update this section in the same pull request.

## Supported environments

We aim for these combinations. We have not evaluated every one yet. Do not read this list as a verified support matrix.

- **Web (desktop):** the latest two versions of Chrome, Edge, Firefox, and Safari.
- **Web (mobile):** the latest two versions of Mobile Safari and Chrome on Android.
- **Assistive technology:** VoiceOver (macOS / iOS), NVDA (Windows), JAWS (Windows), TalkBack (Android).

Partial-support notes:

- Deployed WordPress and WooCommerce admin screens inherit upstream behavior. We have not measured every admin screen with assistive technology on Pagefeather.
- Third-party plugins and themes you add at deploy time are outside our default evaluation. Heavy plugins also hit memory and size limits ([How many plugins fit](docs/guide/limits.md#how-many-plugins-fit)).
- Embedded third-party widgets on the marketing site are best-effort only. The
  product site does not load Cloudflare Insights / Web Analytics beacons.

## Known limitations

We do not claim that there are no barriers. What we know today:

- We have not published a formal WCAG evaluation for www.pagefeather.dev or for a default deployed site.
- CI does not yet run an accessibility scanner on every pull request.
- There is no dedicated accessibility issue form yet. Use the bug template and the `accessibility:` title prefix above.
- Docs and README tables are dense in places. We are thinning the public front door (see the guide path under [docs/README.md](docs/README.md)). Dense tables can be harder with a screen reader. Prefer the guide pages when you can.
- Product limits (memory resets under load, cache freshness, install steps) can affect real use. Those limits are listed on [Known limitations](docs/guide/limits.md). They are product facts, not accessibility excuses.

If you find a barrier that is not listed here, please open an issue.

## Feedback

Accessibility is ongoing work, not a one-time fix. To improve this statement or our practices, open an issue or a pull request. To report a barrier you hit, use [Reporting accessibility issues](#reporting-accessibility-issues) above.

Thank you for helping make Pagefeather usable by more people.
