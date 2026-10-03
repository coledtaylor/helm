import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Testing Library unmounts after each test on its own only where test globals
// are on; this suite imports from vitest instead.
afterEach(cleanup)

// jsdom does no layout, so the layout calls components make are no-ops here.
// Anything that depends on where something actually lands belongs in an
// end-to-end test.
Element.prototype.scrollIntoView ??= function scrollIntoView() {}
