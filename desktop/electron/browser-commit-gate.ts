/**
 * Does this agent click (or Enter) commit the person to something — buying,
 * paying, booking, placing an order, sending a message, deleting? Decided
 * from plain data so every rule is unit-tested (scripts/test-browser-vault.mjs).
 *
 * Why this exists: until 0.29 only the agent's manual *asked* it to check with
 * the user before submitting a purchase. A request in a prompt is not a
 * control (AGENTS.md §4.6, "enforce in the loop"). Now main classifies the
 * element the agent is about to click, and a commit needs the person's
 * explicit Allow in an AICO prompt that says what will happen; a deny, or no
 * answer, means nothing is clicked.
 *
 * WHERE THE LINE IS. The gate fires on the action that commits, not on the
 * steps that lead to a review page:
 *   - gated: "Place order", "Pay now", "Buy now", "Complete purchase",
 *     "Confirm booking", "Send", "Post", "Delete account", "Zahlungspflichtig
 *     bestellen", "Finalizar compra", "Payer", "注文を確定する"… and a form
 *     submitted to a checkout/payment/order endpoint from a checkout page;
 *   - not gated: "Add to cart", "View basket", "Proceed to checkout",
 *     "Continue to payment", "Next", "Search", "Sign in", "Save draft",
 *     "Remove" (an item from a cart), "Apply coupon" — they change nothing
 *     that cannot be undone, or lead to a page where the commit is asked again.
 * Ambiguous words ("Book now", "Reserve", "Subscribe", "Donate", "Submit",
 * "Confirm", "Continue") are gated only on a page that looks like a checkout
 * (payment fields, an order summary, a checkout URL). A false positive costs
 * the person one click; a false negative costs their money.
 *
 * What it deliberately does not do: read the page. browser.ts collects the
 * signals (in the page, read-only) and asks here, in main.
 *
 * @module desktop/electron/browser-commit-gate
 */

export type CommitKind = 'purchase' | 'booking' | 'send' | 'delete' | 'subscribe';

export interface CommitSignals {
  /** What the person would read on the control: text, value, aria-label, title. */
  label: string;
  /** The control's tag and type ('button', 'submit', 'a', 'input'). */
  tag?: string;
  type?: string;
  /** Does activating it submit a form? */
  submits?: boolean;
  /** The form's action URL, when it submits one. */
  formAction?: string;
  /** For an Enter key: the labels of the form's submit buttons. */
  formButtons?: string[];
  /** The page. */
  url?: string;
  title?: string;
  /** Page cues from page-signals (checkout page, place-order button, card fields). */
  checkout?: boolean;
  cardFields?: number;
}

export interface CommitVerdict { kind: CommitKind; reason: string; label: string }

const norm = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 160);

/** Never a commit on its own, whatever the page: moving towards a checkout, not through it. */
const NOT_COMMIT = /^(add (it )?to (cart|bag|basket|trolley|wishlist|list)|in den (warenkorb|einkaufswagen)|añadir al (carrito|cesta)|ajouter au (panier|chariot)|aggiungi al carrello|in winkelwagen|カートに入れる|加入购物车|view (cart|bag|basket)|go to (cart|bag|basket)|(proceed|continue|go) to (checkout|payment|shipping|delivery)|checkout$|zur kasse|pasar por caja|passer (la )?commande$|apply( coupon| code| promo)?|remove( item| from (cart|bag|basket))?$|save( for later| draft)?$|sign ?in|log ?in|sign ?up|register|search|next$|back$|cancel$)/i;

const STRONG: Array<[RegExp, CommitKind]> = [
  // Buying / paying (EN, DE, ES, PT, FR, IT, NL, JA, ZH).
  [/^(place (my |your |the )?order|pay( now| securely| and place order)?\b|buy( it)? now|complete (my |your )?(purchase|order|payment|checkout)|confirm (and pay|order|purchase|payment|and place order)|submit (order|payment)|order now|purchase( now)?|checkout and pay|pay \W?\d|pay with |make payment|authori[sz]e payment)/i, 'purchase'],
  [/^(jetzt kaufen|kaufen$|zahlungspflichtig bestellen|jetzt bezahlen|bezahlen$|bestellung abschicken|kostenpflichtig bestellen)/i, 'purchase'],
  [/^(comprar( ahora| ya)?$|pagar( ahora)?$|finalizar (compra|pedido)|realizar (el )?pedido|confirmar (compra|pedido|pago)|finalizar pagamento|fazer pedido)/i, 'purchase'],
  [/^(payer( maintenant)?$|acheter( maintenant)?$|valider (la |ma )?commande|confirmer (la |ma )?commande|commander et payer|passer la commande et payer)/i, 'purchase'],
  [/^(acquista( ora)?$|paga( ora| adesso)?$|conferma (l'?)?(ordine|acquisto|pagamento)|procedi (con l'?|all'?)acquisto)/i, 'purchase'],
  [/^(koop nu|nu kopen|betalen$|bestelling plaatsen|nu betalen)/i, 'purchase'],
  [/(注文を確定|購入する|今すぐ購入|支払う|立即购买|提交订单|确认付款|立即支付|去付款)/, 'purchase'],
  // Booking.
  [/^(confirm (booking|reservation)|complete (booking|reservation)|book and pay|reserve and pay|jetzt verbindlich buchen|confirmar reserva|confirmer la réservation|conferma prenotazione)/i, 'booking'],
  // Sending / posting.
  [/^(send( message| email| mail| it| now| reply)?$|post( reply| comment| now)?$|publish( now)?$|tweet$|share post$|submit (comment|review|post|reply)|senden$|nachricht senden|enviar( mensaje| correo)?$|envoyer( le message)?$|invia( messaggio)?$|verstuur$|verzenden$|送信$|发送$|投稿する)/i, 'send'],
  // Deleting.
  [/^(delete( permanently| forever| account| repository| project| everything| all)?$|permanently delete|erase( all)?$|destroy$|close (my |your )?account|deactivate account|cancel (my |your )?(subscription|membership|account|order)|empty (trash|bin)|löschen$|endgültig löschen|eliminar( cuenta)?$|borrar$|supprimer( définitivement)?$|elimina$|verwijderen$|削除$|删除$)/i, 'delete'],
];

const AMBIGUOUS: Array<[RegExp, CommitKind]> = [
  [/^(book( now| it)?$|reserve( now)?$|buchen$|reservar$|réserver$|prenota$)/i, 'booking'],
  [/^(subscribe( now)?$|start (my |your )?(subscription|membership|trial)|donate( now)?$|abonnieren$|suscribirse$|s'abonner$)/i, 'subscribe'],
  [/^(submit$|confirm$|continue$|place$|complete$|finish$|weiter$|bestätigen$|continuar$|confirmar$|continuer$|confirmer$|conferma$)/i, 'purchase'],
];

const COMMIT_ACTION = /(\/|\b)(checkout|payment|pay|purchase|place-?order|placeorder|order\/(submit|confirm|place)|billing\/submit|transaction|charge)(\b|\/|$|\?)/i;
const CHECKOUT_URL = /\/(checkout|payment|pay|billing|order[-/]?(review|confirm|summary))(\/|$|\?|#)/i;

function match(label: string, table: Array<[RegExp, CommitKind]>): CommitKind | null {
  for (const [re, kind] of table) if (re.test(label)) return kind;
  return null;
}

/** Is this action a commit? null when it is not (the common case). */
export function classifyCommit(s: CommitSignals): CommitVerdict | null {
  const labels = [s.label, ...(s.formButtons ?? [])].map(norm).filter(Boolean);
  const checkoutish = Boolean(s.checkout) || (s.cardFields ?? 0) > 0 || CHECKOUT_URL.test(s.url ?? '');
  for (const label of labels) {
    if (NOT_COMMIT.test(label)) continue;
    const strong = match(label, STRONG);
    if (strong) return { kind: strong, label, reason: `the control says “${label}”` };
    if (checkoutish) {
      const weak = match(label, AMBIGUOUS);
      if (weak) return { kind: weak, label, reason: `“${label}” on a checkout page` };
    }
  }
  // A form posted to a checkout / payment endpoint from a checkout page, whatever its button says.
  if (s.submits && s.formAction && COMMIT_ACTION.test(s.formAction) && checkoutish) {
    const label = labels[0] ?? '';
    if (!label || !NOT_COMMIT.test(label)) return { kind: 'purchase', label, reason: `it submits the form to ${s.formAction.slice(0, 120)} on a checkout page` };
  }
  return null;
}

/** What the person is asked. */
export function commitQuestion(v: CommitVerdict, origin: string): { title: string; detail: string; okLabel: string } {
  const what: Record<CommitKind, string> = {
    purchase: 'buy or pay for something', booking: 'make a booking', send: 'send or publish something', delete: 'delete something', subscribe: 'start a subscription or payment',
  };
  const verb: Record<CommitKind, string> = { purchase: 'Allow purchase', booking: 'Allow booking', send: 'Allow sending', delete: 'Allow delete', subscribe: 'Allow' };
  return {
    title: `The agent is about to ${what[v.kind]} on ${origin}`,
    detail: `It wants to press “${v.label || 'submit'}” (${v.reason}). This may not be reversible. Nothing happens unless you allow it.`,
    okLabel: verb[v.kind],
  };
}
