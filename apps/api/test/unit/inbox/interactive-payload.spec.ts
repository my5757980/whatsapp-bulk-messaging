import { describe, expect, it } from 'vitest';
import { interactiveFor } from '../../../src/modules/inbox/messages/interactive-payload.js';

// 003 T013: Graph `interactive` objects for flow buttons and lists (contracts/meta-graph-flows.md §1–2).
describe('interactiveFor', () => {
  it('builds reply buttons with an optional header and footer', () => {
    expect(
      interactiveFor('BUTTONS', 'Anything else?', {
        header: 'Opening hours',
        footer: 'Reply with a button',
        buttons: [
          { id: 's:abc:3:loc', title: 'Location' },
          { id: 's:abc:3:human', title: 'Talk to us' },
        ],
        flow: { flowId: 'f' },
      }),
    ).toEqual({
      type: 'button',
      header: { type: 'text', text: 'Opening hours' },
      body: { text: 'Anything else?' },
      footer: { text: 'Reply with a button' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 's:abc:3:loc', title: 'Location' } },
          { type: 'reply', reply: { id: 's:abc:3:human', title: 'Talk to us' } },
        ],
      },
    });
  });

  it('leaves out an empty header and footer', () => {
    const result = interactiveFor('BUTTONS', 'Pick one', { header: null, footer: null, buttons: [{ id: 'x', title: 'Yes' }] });
    expect(result).not.toHaveProperty('header');
    expect(result).not.toHaveProperty('footer');
  });

  it('builds a list with sections, titles and descriptions', () => {
    expect(
      interactiveFor('LIST', 'Which branch suits you?', {
        buttonLabel: 'Choose a branch',
        sections: [
          {
            title: 'Dubai',
            rows: [
              { id: 's:abc:5:marina', title: 'Dubai Marina', description: 'Open until 10 pm' },
              { id: 's:abc:5:deira', title: 'Deira' },
            ],
          },
          { rows: [{ id: 's:abc:5:online', title: 'Online' }] },
        ],
      }),
    ).toEqual({
      type: 'list',
      body: { text: 'Which branch suits you?' },
      action: {
        button: 'Choose a branch',
        sections: [
          {
            title: 'Dubai',
            rows: [
              { id: 's:abc:5:marina', title: 'Dubai Marina', description: 'Open until 10 pm' },
              { id: 's:abc:5:deira', title: 'Deira' },
            ],
          },
          { rows: [{ id: 's:abc:5:online', title: 'Online' }] },
        ],
      },
    });
  });
});
