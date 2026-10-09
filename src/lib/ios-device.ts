/** Keep touch reading behavior on iPhone and iPad, including iPadOS desktop-site mode. */
export function isIPhoneOrIPad() {
    if (typeof navigator === 'undefined') return false;
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
