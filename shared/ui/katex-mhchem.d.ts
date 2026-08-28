/**
 * mhchem has no types of its own.
 *
 * It exports nothing — importing it attaches `\ce` and `\pu` to whichever KaTeX
 * instance is already loaded — so there is nothing to describe beyond the fact
 * that the module exists and may be imported for its effect.
 */
declare module 'katex/dist/contrib/mhchem.mjs';
