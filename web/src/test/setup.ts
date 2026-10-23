import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => cleanup());
configure({ asyncUtilTimeout: 15000 });   // CPU kontainer build jauh lebih lambat dari mesin lokal; 1 dtk bawaan membuat findBy gagal acak

// jsdom belum mengimplementasikan <dialog>.showModal/close
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
}
