<!-- A profile's picture, or its initials on a colour of its own -->
<script>
  import { avatarPic, colorOf, initials } from './profile.js';
  let { user, class: cls = '' } = $props();
  const pic = $derived(avatarPic(user));
</script>

{#if pic}
  <span class="avatar pic {cls}"><img src={pic} alt=""></span>
{:else}
  <span class="avatar {cls}" style:background={colorOf(user.id)}>{initials(user.name)}</span>
{/if}
