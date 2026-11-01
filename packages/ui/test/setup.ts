import { setProjectAnnotations } from '@storybook/react-vite';
import preview from '../.storybook/preview';

setProjectAnnotations(preview);

// Overlays fade in over 150 ms; axe must measure final colors, not a frame of the fade.
const style = document.createElement('style');
style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }';
document.head.appendChild(style);
