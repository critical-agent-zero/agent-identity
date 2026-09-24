// Shared TEST fixture for the SSH-signing suites (issue #120). FIX_KEY is a
// THROWAWAY ed25519 key generated once with `ssh-keygen -t ed25519` — it
// authenticates nothing and guards no resource; its only role is a
// deterministic oracle. FIX_SIG is exactly what `ssh-keygen -Y sign -n git`
// emitted for FIX_MSG under FIX_KEY, so any SSHSIG implementation must
// reproduce it byte-for-byte (ed25519 is deterministic). Not a `.test.ts`
// file, so it is imported by the suites rather than run as one.
export const FIX_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACA06o4gCKXe8xCCUF/PFNjzfS0aK0k7zzOhtxnGdDwdkgAAAJgdirSyHYq0
sgAAAAtzc2gtZWQyNTUxOQAAACA06o4gCKXe8xCCUF/PFNjzfS0aK0k7zzOhtxnGdDwdkg
AAAEAmBdd6tQ80RdAMQPlJPKBYcjam7ncR834PIkNf35CKfTTqjiAIpd7zEIJQX88U2PN9
LRorSTvPM6G3GcZ0PB2SAAAAE3NzaHNpZy10ZXN0LWZpeHR1cmUBAg==
-----END OPENSSH PRIVATE KEY-----
`;
export const FIX_MSG = Buffer.from("agent-identity SSHSIG gold fixture v1\n");
export const FIX_SIG = `-----BEGIN SSH SIGNATURE-----
U1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAgNOqOIAil3vMQglBfzxTY830tGi
tJO88zobcZxnQ8HZIAAAADZ2l0AAAAAAAAAAZzaGE1MTIAAABTAAAAC3NzaC1lZDI1NTE5
AAAAQJWQ41EE6z91EVsVvdRROzLVQAvGcVnGT9Co1OFBxvPfuaRKdKHhAHkgh2F/dLiI4M
KuEbC4dhV/7dtrO/cjvAs=
-----END SSH SIGNATURE-----
`;
