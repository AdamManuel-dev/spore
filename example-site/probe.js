// Runs only if the reader opted this site in to scripts. Its whole job is to
// make that decision visible: the box is red until a script is allowed to
// touch it, and nothing else on the page depends on this file.
const probe = document.getElementById('probe')
probe.textContent = 'Scripts are on for this site.'
probe.classList.add('on')
