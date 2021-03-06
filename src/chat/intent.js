// Intent Service
// Handles all inbound message triggers

var moment = require('moment');
var domain = require('domain');

function IntentService(bot) {
    this.bot = bot;
    this.commands = [];
    this.listeners = [];
    this.squelch_timers = [];
    this.prompts = bot.config.responds_to.map(function (name) {
        return new RegExp('^\@?' + name + '\:? ');
    });

    // Listen to all inbound events
    this.bot.events.on('sawMessage', this.handleMessage.bind(this));
}

// Load an individual command. Bind it to the bot.
IntentService.prototype.loadCommand = function (spec) {
    this.commands.push({
        trigger : spec.trigger,
        core : spec.core,
        func : spec.func.bind(this.bot)
    });
};

// Load an individual listener. Bind it to the bot.
IntentService.prototype.loadListener = function (spec) {
    this.listeners.push({
        trigger : spec.trigger,
        func : spec.func.bind(this.bot)
    });
};

// Splits arguments along spaces, unless arg is in quotes.
IntentService.prototype.splitArgs = function (message) {
    var args = [];

    var split = message.trim()              // Trim whitespace
        .replace(/[\u2018\u2019]/g, "'")    // Replace funny mac characters
        .replace(/[\u201C\u201D]/g, '"')
        .split(' ');                        // Split on spaces

    var quote = null;
    var quotedstring = [];

    split.forEach(function (token) {
        // If we aren't in a quoted string, check to see if we should start one
        if (quote === null) {
            if (token[0] === '"' || token[0] === "'") {
                quote = token[0];

                // Check for single words, quoted
                if (token[token.length - 1] === quote) {
                    quote = null;
                    args.push(token.slice(1, -1));
                } else {
                    quotedstring = [token.slice(1)];
                }
            } else {
                args.push(token);
            }

        // If we are in a quoted string, check to see if we should exit it
        } else {
            if (token[token.length - 1] === quote) {
                quote = null;
                quotedstring.push(token.slice(0, -1));
                args.push(quotedstring.join(' '));
                quotedstring = [];
            } else {
                quotedstring.push(token);
            }
        }
    });

    // If we're still in a quote, add it back in.
    if (quotedstring.length) {
        args.push(quotedstring.join(' '));
    }

    return args;
};

IntentService.prototype.squelch = function (room, squelched) {
    if (typeof squelched === 'undefined') {
        squelched = true;
    }

    var time = moment();

    if (squelched) {
        time.add(10, 'minute');
    }
    this.squelch_timers[room] = time;
    console.log('Squelched in', room, 'until', time.format('h:mm:ss'));
};

IntentService.prototype.squelched = function (room) {
    if (room && this.squelch_timers[room]) {
        var delta = moment().diff(this.squelch_timers[room]);
        return delta < 0;
    } else {
        return false;
    }
};

// Handle a single inbound message along given route
function handleMessage(route, message) {
    var matches = [],
        isCommand = (route.room === null), // All direct messages are interpreted as commands
        i, matched;

    // Commands in rooms are prefixed with the bot name (or alias)
    // If so, remove the name to get just the command.
    for (i = 0; i < this.prompts.length; i++) {
        matched = message.match(this.prompts[i]);
        if (matched) {
            isCommand = true;
            message = message.slice(matched[0].length);
            break;
        }
    }

    if (isCommand) {
        // Find all matches
        for (i = 0; i < this.commands.length; i++) {
            var command = this.commands[i];

            matched = command.trigger.exec(message);
            if (matched && matched.index === 0) {
                // Do not process non-core commands if currently squelched
                if (command.core || !this.squelched(route.room)) {
                    matched.func = command.func;
                    matches.push(matched);
                } else {
                    console.log('Bot is squelched, not processing command');
                }
            }
        }

        if (matches.length) {
            matched = [''];

            // Pick the match that matched the longest substring
            // Semi-intelligently handles cases where multiple commands match
            for (i = 0; i < matches.length; i++) {
                if (matches[i][0].length > matched[0].length) {
                    matched = matches[i];
                }
            }

            // Call the command and pass in arguments.
            matched.func(route, this.splitArgs(message.slice(matched[0].length)));

            // Do not execute any listeners if a command matched.
            return;
        }
    }

    // Do not process listener if currently shut up.
    if (!this.squelched(route.room)) {
        // Check for listener matches
        matches = [];
        for (i = 0; i < this.listeners.length; i++) {
            matched = this.listeners[i].trigger.exec(message);

            if (matched) {
                matched.func = this.listeners[i].func;
                matches.push(matched);
            }
        }

        // Listeners are executed in order of match length
        // Execution stops if a listener returns true, otherwise the next longest listener is executed. This can result in multiple responses.
        // In practice a synchronous listeners should always return true if they respond, and listeners with async (for example, db calls) return false.
        if (matches.length) {
            matches.sort(function (a, b) {
                return a[0].length > b[0].length;
            });

            for (i = 0; i < matches.length; i++) {
                if (matches[i].func(route, message)) {
                    return;
                }
            }
        }
    }

    // If this was a command (prefixed by the bot name/alias) but we couldn't understand anything from it, express our confusion.
    if (isCommand) {
        if (this.squelched(route.room)) {
            route.direct().send('?command_but_silenced', route.room);
        } else {
            route.send('?command_not_found');
        }
    }
}

// Handle message in a domain wrapper to catch errors.
IntentService.prototype.handleMessage = function (route, message) {
    var handler_domain = domain.create();
    handler_domain.add(route);
    handler_domain.add(this);

    handler_domain.on('error', function (er) {
        console.log('Unhandled error processing message:', message, '\n', er.stack);
        route.send('?generic_error');
    });

    handler_domain.run(function () {
        handleMessage.bind(this)(route, message);
    }.bind(this));
};

module.exports = IntentService;
