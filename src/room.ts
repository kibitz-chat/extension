// The derivation lives in core — the website's paste-a-URL flow uses the SAME
// function, so extension users and link users land in the same room.
export { roomForUrl } from '../core/pageRoom'
