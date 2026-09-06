import { initAccessibility } from './a11y.js';

/**
 * CRSF token for requests.
 */
let csrfToken = '';
let discreetLogin = false;

/**
 * Gets a CSRF token from the server.
 * @returns {Promise<string>} CSRF token
 */
async function getCsrfToken() {
    const response = await fetch('/csrf-token');
    const data = await response.json();
    return data.token;
}

/**
 * Gets a list of users from the server.
 * @returns {Promise<object>} List of users
 */
async function getUserList() {
    const response = await fetch('/api/users/list', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
        },
    });

    if (!response.ok) {
        const errorData = await response.json();
        return displayError(errorData.error || 'An error occurred');
    }

    if (response.status === 204) {
        discreetLogin = true;
        return [];
    }

    const userListObj = await response.json();
    console.log(userListObj);
    return userListObj;
}

/**
 * Requests a recovery code for the user.
 * @param {string} handle User handle
 * @returns {Promise<void>}
 */
async function sendRecoveryPart1(handle) {
    const response = await fetch('/api/users/recover-step1', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ handle }),
    });

    if (!response.ok) {
        const errorData = await response.json();
        return displayError(errorData.error || 'An error occurred');
    }

    showRecoveryBlock();
}

/**
 * Sets a new password for the user using the recovery code.
 * @param {string} handle User handle
 * @param {string} code Recovery code
 * @param {string} newPassword New password
 * @returns {Promise<void>}
 */
async function sendRecoveryPart2(handle, code, newPassword) {
    const recoveryData = {
        handle,
        code,
        newPassword,
    };

    const response = await fetch('/api/users/recover-step2', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(recoveryData),
    });

    if (!response.ok) {
        const errorData = await response.json();
        return displayError(errorData.error || 'An error occurred');
    }

    console.log(`Successfully recovered password for ${handle}!`);
    await performLogin(handle, newPassword);
}

/**
 * Registers a new user account.
 * @param {string} handle User handle
 * @param {string} name Display name
 * @param {string} password Password
 * @returns {Promise<void>}
 */
async function performRegister(handle, name, password) {
    const payload = {
        handle: String(handle || '').trim(),
        name: String(name || '').trim() || String(handle || '').trim(),
        password: String(password || ''),
    };

    if (!payload.handle || !payload.password) {
        return displayError('Handle and password are required');
    }

    try {
        const response = await fetch('/api/users/register', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken,
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorData = await response.json();
            return displayError(errorData.error || 'An error occurred');
        }

        $('#userHandle').val(payload.handle);
        $('#userPassword').val(payload.password);
        await performLogin(payload.handle, payload.password);
    } catch (error) {
        console.error('Error registering:', error);
        displayError(String(error));
    }
}

/**
 * Attempts to log in the user.
 * @param {string} handle User's handle
 * @param {string} password User's password
 * @returns {Promise<void>}
 */
async function performLogin(handle, password) {
    const userInfo = {
        handle: handle,
        password: password,
    };

    try {
        const response = await fetch('/api/users/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken,
            },
            body: JSON.stringify(userInfo),
        });

        if (!response.ok) {
            const errorData = await response.json();
            return displayError(errorData.error || 'An error occurred');
        }

        const data = await response.json();

        if (data.handle) {
            console.log(`Successfully logged in as ${handle}!`);
            redirectToHome();
        }
    } catch (error) {
        console.error('Error logging in:', error);
        displayError(String(error));
    }
}

/**
 * Handles the user selection event.
 * @param {object} user User object
 * @returns {Promise<void>}
 */
async function onUserSelected(user) {
    // No password, just log in
    if (!user.password) {
        return await performLogin(user.handle, '');
    }

    $('#userHandle').val(user.handle);
    $('#userPassword').val('');
    $('#registerEntryBlock').hide();
    $('#passwordRecoveryBlock').hide();
    $('#passwordEntryBlock').show();

    displayError('');
}

/**
 * Displays an error message to the user.
 * @param {string} message Error message
 */
function displayError(message) {
    $('#errorMessage').text(message);
}

/**
 * Redirects the user to the home page.
 * Preserves the query string.
 */
function redirectToHome() {
    // Create a URL object based on the current location
    const currentUrl = new URL(window.location.href);

    // After a login there's no need to preserve the
    // noauto parameter (if present)
    currentUrl.searchParams.delete('noauto');

    // Set the pathname to root and keep the updated query string
    currentUrl.pathname = '/';

    // Redirect to the new URL
    window.location.href = currentUrl.toString();
}

/**
 * Hides the password entry block and shows the password recovery block.
 */
function showRecoveryBlock() {
    $('#registerEntryBlock').hide();
    $('#passwordEntryBlock').hide();
    $('#passwordRecoveryBlock').show();
    displayError('');
}

/**
 * Shows register block.
 */
function showRegisterBlock() {
    $('#passwordRecoveryBlock').hide();
    $('#passwordEntryBlock').hide();
    $('#registerEntryBlock').show();
    $('#registerHandle').val(String($('#userHandle').val() || ''));
    displayError('');
}

/**
 * Hides register block and shows login block.
 */
function hideRegisterBlock() {
    $('#registerEntryBlock').hide();
    $('#passwordRecoveryBlock').hide();
    $('#passwordEntryBlock').show();
    displayError('');
}

/**
 * Hides the password recovery block and shows the password entry block.
 */
function onCancelRecoveryClick() {
    $('#passwordRecoveryBlock').hide();
    $('#registerEntryBlock').hide();
    $('#passwordEntryBlock').show();
    displayError('');
}

/**
 * Configures the login page for normal login.
 * @param {import('../../src/users').UserViewModel[]} userList List of users
 */
function configureNormalLogin(userList) {
    console.log('Discreet login is disabled');
    $('#handleEntryBlock').show();
    $('#passwordEntryBlock').show();
    $('#registerEntryBlock').hide();
    $('#passwordRecoveryBlock').hide();
    $('#normalLoginPrompt').show();
    $('#discreetLoginPrompt').hide();
    console.log(userList);
    for (const user of userList) {
        const userBlock = $('<div></div>').addClass('userSelect');
        const avatarBlock = $('<div></div>').addClass('avatar');
        avatarBlock.append($('<img>').attr('src', user.avatar));
        userBlock.append(avatarBlock);
        userBlock.append($('<span></span>').addClass('userName').text(user.name));
        userBlock.append($('<small></small>').addClass('userHandle').text(user.handle));
        userBlock.on('click', () => onUserSelected(user));
        $('#userList').append(userBlock);
    }
}

/**
 * Configures the login page for discreet login.
 */
function configureDiscreetLogin() {
    console.log('Discreet login is enabled');
    $('#handleEntryBlock').show();
    $('#normalLoginPrompt').hide();
    $('#discreetLoginPrompt').show();
    $('#userList').hide();
    $('#passwordRecoveryBlock').hide();
    $('#registerEntryBlock').hide();
    $('#passwordEntryBlock').show();
}

(async function () {
    initAccessibility();

    csrfToken = await getCsrfToken();
    const userList = await getUserList();

    if (discreetLogin) {
        configureDiscreetLogin();
    } else {
        configureNormalLogin(userList);
    }
    $('#loginButton').off('click').on('click', async () => {
        const handle = String($('#userHandle').val());
        const password = String($('#userPassword').val());
        await performLogin(handle, password);
    });
    $('#recoverPassword').off('click').on('click', async () => {
        const handle = String($('#userHandle').val());
        await sendRecoveryPart1(handle);
    });
    $('#sendRecovery').off('click').on('click', async () => {
        const handle = String($('#userHandle').val());
        const code = String($('#recoveryCode').val());
        const newPassword = String($('#newPassword').val());
        await sendRecoveryPart2(handle, code, newPassword);
    });
    $('#openRegister').off('click').on('click', showRegisterBlock);
    $('#cancelRegister').off('click').on('click', hideRegisterBlock);
    $('#registerButton').off('click').on('click', async () => {
        const handle = String($('#registerHandle').val());
        const name = String($('#registerName').val());
        const password = String($('#registerPassword').val());
        await performRegister(handle, name, password);
    });
    document.getElementById('shadow_popup').style.opacity = '';
    $('#cancelRecovery').on('click', onCancelRecoveryClick);
    $(document).on('keydown', (evt) => {
        if (evt.key === 'Enter' && document.activeElement.tagName === 'INPUT') {
            if ($('#registerEntryBlock').is(':visible')) {
                $('#registerButton').trigger('click');
            } else if ($('#passwordRecoveryBlock').is(':visible')) {
                $('#sendRecovery').trigger('click');
            } else {
                $('#loginButton').trigger('click');
            }
        }
    });
})();
