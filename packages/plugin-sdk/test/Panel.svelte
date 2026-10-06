<script>
  // A plugin panel written the way the README tells a Svelte author to: the
  // stores as they are, read with `$`.
  import { secret, settings, theme, visible } from '../src/stores.js'

  const token = secret('github-token')
</script>

<p data-testid="settings">{$settings === null ? 'reading' : $settings.query}</p>
<p data-testid="visible">{$visible ? 'shown' : 'hidden'}</p>
<p data-testid="theme">{$theme.kind}</p>
<p data-testid="token">{$token ?? 'reading'}</p>
<button onclick={() => token.request()}>Add token</button>
