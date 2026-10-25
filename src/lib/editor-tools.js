export const groups = [
    {
      id: 'select',
      primary: 'select',
      tools: [
        { id: 'select', label: 'Select', shortcut: 'V' },
        { id: 'pan', label: 'Pan', shortcut: 'P' },
        { id: 'zoom', label: 'Zoom', shortcut: 'Z' }
      ]
    },
    {
      id: 'drawing',
      primary: 'marker',
      tools: [
        { id: 'marker', label: 'Marker', shortcut: 'M' },
        { id: 'pen', label: 'Pen', shortcut: 'N' },
        { id: 'eraser', label: 'Eraser', shortcut: 'E' }
      ]
    },
    {
      id: 'shapes',
      primary: 'triangle',
      tools: [
        { id: 'triangle', label: 'Triangle', shortcut: 'T' },
        { id: 'rectangle', label: 'Rectangle', shortcut: 'R' },
        { id: 'circle', label: 'Circle', shortcut: 'C' },
        { id: 'check', label: 'Check', shortcut: 'K' },
        { id: 'cross', label: 'Cross', shortcut: 'X' },
        { id: 'arrow', label: 'Arrow', shortcut: 'A' },
        { id: 'line', label: 'Line', shortcut: 'L' }
      ]
    },
    {
      id: 'text',
      primary: 'textfield',
      tools: [
        { id: 'textfield', label: 'Text Field', shortcut: 'F' },
        { id: 'edit', label: 'Edit Text', shortcut: 'D' },
        { id: 'highlight', label: 'Highlight', shortcut: 'H' },
        { id: 'crossout', label: 'Cross Out', shortcut: 'Q' },
        { id: 'underline', label: 'Underline', shortcut: 'U' },
        { id: 'image', label: 'Image', shortcut: 'I' }
      ]
    },
    {
      id: 'protect',
      primary: 'protect',
      tools: [
        { id: 'protect', label: 'Protect', shortcut: 'G' },
        { id: 'blackout', label: 'Blackout', shortcut: 'B' },
        { id: 'whiteout', label: 'Whiteout', shortcut: 'W' }
      ]
    },
    {
      id: 'sign',
      primary: 'sign',
      tools: [
        { id: 'sign', label: 'Sign', shortcut: 'S' },
        { id: 'checkbox', label: 'Checkbox', shortcut: 'J' },
        { id: 'input', label: 'Input', shortcut: 'O' }
      ]
    },
    {
      id: 'measure',
      primary: 'measure',
      tools: [
        { id: 'measure', label: 'Measure', shortcut: 'Y' },
        { id: 'crop', label: 'Crop', shortcut: '1' }
      ]
    },
    {
      id: 'document',
      primary: 'translate',
      tools: [
        { id: 'translate', label: 'Translate', shortcut: '2' },
        { id: 'ocr', smallIcon: 'orc', designIcon: 'scan-text', label: 'OCR', shortcut: '3' },
        { id: 'search', label: 'Find', shortcut: '4' },
        { id: 'watermark', label: 'Watermark', shortcut: '5' }
      ]
    }
  ];

/** @type {Record<string, string>} */
  export const toolDescriptions = {
    select: 'Select and inspect objects or text.', pan: 'Move around the document canvas.', zoom: 'Zoom into an area of the document.',
    marker: 'Draw a translucent marker stroke.', pen: 'Draw a freehand pen stroke.', eraser: 'Erase drawings and annotations.',
    triangle: 'Add a triangle shape.', rectangle: 'Add a rectangle shape.', circle: 'Add a circle shape.', check: 'Add a check mark.', cross: 'Add a cross mark.', arrow: 'Add an arrow.', line: 'Add a straight line.',
    textfield: 'Add a new text field.', edit: 'Edit existing PDF text.', highlight: 'Highlight selected text.', crossout: 'Strike through selected text.', underline: 'Underline selected text.', image: 'Place an image in the PDF.',
    protect: 'Protect the PDF with a password.', blackout: 'Permanently cover content in black.', whiteout: 'Permanently cover content in white.',
    sign: 'Add a saved or new signature.', checkbox: 'Add a checkbox field.', input: 'Add a fillable input field.',
    measure: 'Measure a distance on the page.', crop: 'Crop the visible page area.',
    ocr: 'Recognize text in scanned pages.', search: 'Find text in the document.', watermark: 'Add a watermark to every page.',
    translate: 'Translate the document into another language.'
  };

export const editorTools = groups.flatMap((group) => group.tools);
