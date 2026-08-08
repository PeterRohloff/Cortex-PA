// Azure Functions v4 entry point — importing each module registers its
// HTTP routes via app.http(...).
import './functions/cases';
import './functions/search';
import './functions/conversation';
import './functions/exportConversation';
import './functions/auditLog';
import './functions/collectTeams';
import './functions/graphNotifications';
