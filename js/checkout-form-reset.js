(function (root, factory) {
  const resetCheckoutForm = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = resetCheckoutForm;
  } else {
    root.resetCheckoutForm = resetCheckoutForm;
  }
})(globalThis, function () {
  return function resetCheckoutForm({
    doc = document,
    resetDobPickerInput,
    resetGradeSelection,
    resetNameKeyboardMode,
  } = {}) {
    ['co-family-name', 'co-given-name', 'co-name'].forEach(id => {
      const input = doc.getElementById(id);
      if (!input) return;
      input.value = '';
      input.setAttribute('readonly', '');
    });

    const emailPart = doc.getElementById('co-email-part');
    if (emailPart) emailPart.value = '';

    doc.querySelectorAll('#row-co-name .name-input-field')
      .forEach(field => field.classList.remove('is-active'));

    if (typeof resetDobPickerInput === 'function') resetDobPickerInput('co-dob');
    if (typeof resetGradeSelection === 'function') resetGradeSelection();
    if (typeof resetNameKeyboardMode === 'function') resetNameKeyboardMode();
  };
});