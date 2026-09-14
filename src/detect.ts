/**
 * Editor-agnostic check for "is this text an RBLang knowledge map?", used by
 * languageDetection.ts to retype `.xml` documents. No VS Code import so the
 * unit tests run under plain node.
 */
import { RBLANG_NAMESPACE } from "./schema";

/** How much of the document to inspect. The root element is within the first few lines. */
const HEAD_CHARS = 2048;

const NAMESPACE_DECL = new RegExp(`xmlns:rbl\\s*=\\s*["']${RBLANG_NAMESPACE.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["']`);
const ROOT_TAG = /<rbl:kb[\s>\/]/;

/**
 * True when the start of `text` is an RBLang knowledge map: the `rbl` prefix
 * is bound to the RBLang namespace, or the `<rbl:kb>` root element appears
 * with no other namespace bound to that prefix. Comments and the XML
 * declaration before the root are skipped over by inspecting a fixed head.
 */
export function looksLikeRblang(text: string): boolean {
  const head = text.slice(0, HEAD_CHARS);
  if (NAMESPACE_DECL.test(head)) return true;
  if (!ROOT_TAG.test(head)) return false;
  // A `<rbl:kb>` root bound to some other namespace is not ours.
  return !/xmlns:rbl\s*=/.test(head);
}
