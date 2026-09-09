/* ── Composer ──
   The card and its two rows — what *adds to* the message behind the "+", what
   governs *how it sends* at the other end — now live in
   `components/composer/composer.tsx`, with the pieces that are a subject of
   their own beside it:

   — `composer/notices.tsx`        the connection banner and the archive note;
   — `composer/add-menu.tsx`       the "+", and the two pickers only it clicks;
   — `composer/text-insertions.ts` what that menu types on the user's behalf,
                                   and the caret slot they all go through;
   — `composer/enhance-button.tsx` the prompt enhancer and every read behind it;
   — `composer/keys.ts`            the one ordering of the completers and Enter;
   — `composer/prompt-history.ts`  the Up walk over what has been sent.

   This file is the barrel those importers still resolve through. */
export { Composer, type ComposerHandle } from "@/components/composer/composer"
