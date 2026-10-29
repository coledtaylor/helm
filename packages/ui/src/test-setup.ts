import { cleanup, configure } from '@testing-library/react'
import { afterEach } from 'vitest'
import { PATIENCE } from '../../../test/patience'

// Testing Library unmounts after each test on its own only where test globals
// are on; this suite imports from vitest instead.
afterEach(cleanup)

// Every `waitFor` and `findBy` waits as long as any other wait in the suite,
// not Testing Library's own second.
configure({ asyncUtilTimeout: PATIENCE })

// jsdom does no layout, so the layout calls components make are no-ops here.
// Anything that depends on where something actually lands belongs in an
// end-to-end test.
Element.prototype.scrollIntoView ??= function scrollIntoView() {}
