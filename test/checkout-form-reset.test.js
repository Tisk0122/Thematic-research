'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const resetCheckoutForm = require('../js/checkout-form-reset.js');

test('clears all checkout inputs and resets related selection state', () => {
    const elements = new Map();
    for (const id of ['co-family-name', 'co-given-name', 'co-name', 'co-email-part']) {
        elements.set(id, {
            value: '入力済み',
            attributes: new Set(),
            setAttribute(name) { this.attributes.add(name); },
        });
    }
    const activeField = {
        removedClasses: [],
        classList: { remove(name) { activeField.removedClasses.push(name); } },
    };
    const calls = [];

    resetCheckoutForm({
        doc: {
            getElementById(id) { return elements.get(id) || null; },
            querySelectorAll(selector) {
                assert.equal(selector, '#row-co-name .name-input-field');
                return [activeField];
            },
        },
        resetDobPickerInput(id) { calls.push(['dob', id]); },
        resetGradeSelection() { calls.push(['grade']); },
        resetNameKeyboardMode() { calls.push(['keyboard']); },
    });

    for (const id of ['co-family-name', 'co-given-name', 'co-name']) {
        const input = elements.get(id);
        assert.equal(input.value, '');
        assert.ok(input.attributes.has('readonly'));
    }
    assert.equal(elements.get('co-email-part').value, '');
    assert.deepEqual(activeField.removedClasses, ['is-active']);
    assert.deepEqual(calls, [['dob', 'co-dob'], ['grade'], ['keyboard']]);
});

test('handles optional checkout fields that are not present', () => {
    assert.doesNotThrow(() => resetCheckoutForm({
        doc: {
            getElementById() { return null; },
            querySelectorAll() { return []; },
        },
    }));
});