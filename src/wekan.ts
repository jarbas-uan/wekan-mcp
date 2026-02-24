// made by namar0x0309 with ❤️ at GoAIX
import { request } from "undici";

export interface WekanLoginResponse {
  id: string;
  token: string;
  tokenExpires: string;
}

export type WekanClientOpts = {
  baseUrl: string;
  token?: string;
  username?: string;
  password?: string;
  userId?: string;
};

// Wekan API response types
export interface WekanBoard {
  _id: string;
  title: string;
  [key: string]: any;
}

export interface WekanList {
  _id: string;
  title: string;
  [key: string]: any;
}

export interface WekanSwimlane {
  _id: string;
  title: string;
  [key: string]: any;
}

export interface WekanCard {
  _id: string;
  title: string;
  description?: string;
  listId?: string;
  swimlaneId?: string;
  [key: string]: any;
}

export interface WekanComment {
  _id: string;
  text?: string;
  comment?: string;
  userId?: string;
  authorId?: string;
  createdAt?: string;
  [key: string]: any;
}

export interface WekanCustomField {
  _id: string;
  name: string;
  type: string;
  [key: string]: any;
}

// Aggregated types for rich responses
export interface CardComment {
  id: string;
  author: string;
  text: string;
}

export interface DetailedCard {
  id: string;
  title: string;
  description: string;
  board: { id: string; title: string };
  list: { id: string; title: string };
  swimlane?: { id: string; title: string };
  assignees: string[];
  startAt?: string;
  endAt?: string;
  dueAt?: string;
  createdAt?: string;
  customFields: Record<string, any>;
  comments?: CardComment[];
  createdBy?: { id: string; name: string };
}

export interface BoardOverview {
  id: string;
  title: string;
  lists: Array<{ id: string; title: string; cardCount: number }>;
  swimlanes: Array<{ id: string; title: string }>;
  customFields: Array<{ id: string; name: string; type: string }>;
}

export class Wekan {
  private token: string | null = null;
  private userCache: Map<string, string> = new Map(); // userId -> username

  constructor(private opts: WekanClientOpts) {}
  
  private async authenticate(): Promise<string> {
    // If we already have a token, use it
    if (this.opts.token) {
      return this.opts.token;
    }
    
    // If we have username/password, login to get token
    if (this.opts.username && this.opts.password) {
      const r = await request(`${this.opts.baseUrl}/users/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: this.opts.username,
          password: this.opts.password
        })
      });
      
      if (r.statusCode >= 400) {
        throw new Error(`Login failed -> ${r.statusCode}`);
      }
      
      const loginResponse = await r.body.json() as WekanLoginResponse;
      this.token = loginResponse.token;
      return this.token;
    }
    
    throw new Error("No authentication method provided. Set WEKAN_API_TOKEN or WEKAN_USERNAME/WEKAN_PASSWORD");
  }

  private async headers() { 
    const token = await this.authenticate();
    return { Authorization: `Bearer ${token}` }; 
  }

  private async requestWithAuth(path: string, options: any): Promise<any> {
    const headers = await this.headers();
    const maxRetries = 2;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const r = await request(`${this.opts.baseUrl}${path}`, {
        ...options,
        headers: { ...headers, ...options.headers }
      });

      if (r.statusCode < 400) {
        return r.body.json();
      }

      // Retry on 5xx (server transient errors) if not last attempt
      if (r.statusCode >= 500 && attempt < maxRetries) {
        // Consume body to avoid memory leak
        await r.body.text().catch(() => {});
        const delay = attempt * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      throw new Error(`${options.method || 'GET'} ${path} -> ${r.statusCode}`);
    }
  }

  async get(path: string): Promise<any> {
    return this.requestWithAuth(path, { method: "GET" });
  }
  
  async post(path: string, body: unknown): Promise<any> {
    return this.requestWithAuth(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {})
    });
  }
  
  async put(path: string, body: unknown): Promise<any> {
    return this.requestWithAuth(path, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {})
    });
  }

  // ============================================
  // Basic API surface
  // ============================================
  async listBoards(userId: string): Promise<WekanBoard[]> {
    if (!userId) {
      throw new Error("WEKAN_USER_ID is required. Run ./get-wekan-token.sh to configure.");
    }
    const result = await this.get(`/api/users/${userId}/boards`);
    return Array.isArray(result) ? result : [];
  }
  listLists(boardId: string): Promise<WekanList[]> { return this.get(`/api/boards/${boardId}/lists`); }
  listSwimlanes(boardId: string): Promise<WekanSwimlane[]> { return this.get(`/api/boards/${boardId}/swimlanes`); }
  listCards(boardId: string, listId: string): Promise<WekanCard[]> { return this.get(`/api/boards/${boardId}/lists/${listId}/cards`); }
  getCard(boardId: string, listId: string, cardId: string): Promise<WekanCard> { return this.get(`/api/boards/${boardId}/lists/${listId}/cards/${cardId}`); }
  getCustomFields(boardId: string): Promise<WekanCustomField[]> { return this.get(`/api/boards/${boardId}/custom-fields`); }
  getCardComments(boardId: string, cardId: string): Promise<WekanComment[]> { return this.get(`/api/boards/${boardId}/cards/${cardId}/comments`); }
  createCard(boardId: string, listId: string, body: any): Promise<WekanCard> { return this.post(`/api/boards/${boardId}/lists/${listId}/cards`, body); }
  moveCard(boardId: string, fromListId: string, cardId: string, body: any): Promise<WekanCard> { return this.put(`/api/boards/${boardId}/lists/${fromListId}/cards/${cardId}`, body); }
  commentCard(boardId: string, cardId: string, authorId: string, comment: string): Promise<WekanComment> { return this.post(`/api/boards/${boardId}/cards/${cardId}/comments`, { authorId, comment }); }

  /**
   * Load all users into cache with their full names (call once to populate)
   * The /api/users endpoint only returns _id and username, so we need to
   * fetch each user individually to get profile.fullname
   */
  async loadUsersCache(): Promise<void> {
    if (this.userCache.size > 0) return; // Already loaded

    try {
      const users = await this.get('/api/users');
      if (Array.isArray(users)) {
        // Fetch full details for each user to get profile.fullname
        await Promise.all(
          users.map(async (user: { _id: string; username: string }) => {
            try {
              const fullUser = await this.get(`/api/users/${user._id}`);
              const name = fullUser.profile?.fullname || fullUser.username || user._id;
              this.userCache.set(user._id, name);
            } catch {
              // Fallback to username if individual fetch fails
              this.userCache.set(user._id, user.username || user._id);
            }
          })
        );
      }
    } catch (e) {
      console.error('Failed to load users cache:', e);
    }
  }

  /**
   * Get username by userId (with in-memory cache to avoid repeated API calls)
   */
  async getUsername(userId: string): Promise<string> {
    if (!userId) return 'Unknown';

    // Ensure cache is loaded
    await this.loadUsersCache();

    // Check cache
    if (this.userCache.has(userId)) {
      return this.userCache.get(userId)!;
    }

    // If not in cache, try individual lookup as fallback
    try {
      const user = await this.get(`/api/users/${userId}`);
      const name = user.profile?.fullname || user.username || userId;
      this.userCache.set(userId, name);
      return name;
    } catch {
      // If we can't get user details, cache the ID itself
      this.userCache.set(userId, userId);
      return userId;
    }
  }

  // ============================================
  // Aggregated methods - simplify agent workflows
  // ============================================

  /**
   * Get board overview with lists, swimlanes, custom fields, and card counts
   */
  async getBoardOverview(boardId: string): Promise<BoardOverview> {
    const [board, lists, swimlanes, customFields] = await Promise.all([
      this.get(`/api/boards/${boardId}`),
      this.listLists(boardId),
      this.listSwimlanes(boardId),
      this.getCustomFields(boardId)
    ]);

    // Get card counts for each list
    const listsWithCounts = await Promise.all(
      lists.map(async (list: WekanList) => {
        const cards = await this.listCards(boardId, list._id);
        return {
          id: list._id,
          title: list.title,
          cardCount: cards.length
        };
      })
    );

    return {
      id: board._id,
      title: board.title,
      lists: listsWithCounts,
      swimlanes: swimlanes.map((s: WekanSwimlane) => ({ id: s._id, title: s.title })),
      customFields: customFields.map((cf: WekanCustomField) => ({ id: cf._id, name: cf.name, type: cf.type }))
    };
  }

  /**
   * Get a single card with full context (board, list, swimlane names, custom fields mapped, comments)
   */
  async getCardWithContext(
    boardId: string,
    listId: string,
    cardId: string,
    includeComments: boolean = true
  ): Promise<DetailedCard> {
    // Fetch all needed data in parallel
    const [card, board, lists, swimlanes, customFieldDefs, comments] = await Promise.all([
      this.getCard(boardId, listId, cardId),
      this.get(`/api/boards/${boardId}`),
      this.listLists(boardId),
      this.listSwimlanes(boardId),
      this.getCustomFields(boardId),
      includeComments ? this.getCardComments(boardId, cardId).catch(() => []) : Promise.resolve([])
    ]);

    // Find list and swimlane titles
    const list = lists.find((l: WekanList) => l._id === listId) || { _id: listId, title: 'Unknown' };
    const swimlane = swimlanes.find((s: WekanSwimlane) => s._id === card.swimlaneId);

    // Map custom field IDs to names
    const fieldIdToName: Record<string, string> = {};
    customFieldDefs.forEach((cf: WekanCustomField) => {
      fieldIdToName[cf._id] = cf.name;
    });

    const mappedCustomFields: Record<string, any> = {};
    const cardCustomFields = card['customFields'] as Array<{_id: string; value: any}> | undefined;
    if (cardCustomFields) {
      for (const cf of cardCustomFields) {
        const fieldName = fieldIdToName[cf._id] || cf._id;
        mappedCustomFields[fieldName] = cf.value;
      }
    }

    const result: DetailedCard = {
      id: card._id,
      title: card.title,
      description: card.description || '',
      board: { id: board._id, title: board.title },
      list: { id: list._id, title: list.title },
      assignees: card['assignees'] || [],
      startAt: card['startAt'],
      endAt: card['endAt'],
      dueAt: card['dueAt'],
      createdAt: card['createdAt'],
      customFields: mappedCustomFields
    };

    if (swimlane) {
      result.swimlane = { id: swimlane._id, title: swimlane.title };
    }

    if (includeComments) {
      // API returns comments newest-first, reverse to get oldest-first (chronological order)
      const sortedComments = [...comments].reverse();
      result.comments = await Promise.all(
        sortedComments.map(async (c: WekanComment) => ({
          id: c._id,
          author: await this.getUsername(c.authorId || c.userId || ''),
          text: c.text || c.comment || ''
        }))
      );
    }

    return result;
  }

  /**
   * Get all detailed cards across boards with optional filters
   * This is the main aggregation method that replaces multiple API calls
   */
  async getDetailedCards(
    userId: string,
    options: {
      boardId?: string;
      listId?: string;
      assigneeId?: string;
      includeComments?: boolean;
    } = {}
  ): Promise<DetailedCard[]> {
    const { boardId, listId, assigneeId, includeComments = false } = options;
    const results: DetailedCard[] = [];

    // Get boards (either specific or all)
    let boards: WekanBoard[];
    if (boardId) {
      const board = await this.get(`/api/boards/${boardId}`);
      boards = [board];
    } else {
      boards = await this.listBoards(userId);
    }

    // Process each board
    for (const board of boards) {
      // Get board metadata in parallel
      const [lists, swimlanes, customFieldDefs] = await Promise.all([
        this.listLists(board._id),
        this.listSwimlanes(board._id),
        this.getCustomFields(board._id)
      ]);

      // Create lookup maps
      const swimlaneMap = new Map(swimlanes.map((s: WekanSwimlane) => [s._id, s]));
      const fieldIdToName: Record<string, string> = {};
      customFieldDefs.forEach((cf: WekanCustomField) => {
        fieldIdToName[cf._id] = cf.name;
      });

      // Filter lists if specific listId provided
      const listsToProcess = listId
        ? lists.filter((l: WekanList) => l._id === listId)
        : lists;

      // Get cards from each list
      for (const list of listsToProcess) {
        const cards = await this.listCards(board._id, list._id);

        for (const card of cards) {
          // Filter by assignee if specified
          const cardAssignees = card['assignees'] as string[] || [];
          if (assigneeId && !cardAssignees.includes(assigneeId)) {
            continue;
          }

          // Get full card details
          const fullCard = await this.getCard(board._id, list._id, card._id);

          // Get comments if requested
          let comments: WekanComment[] = [];
          if (includeComments) {
            comments = await this.getCardComments(board._id, card._id).catch(() => []);
          }

          // Map custom fields
          const mappedCustomFields: Record<string, any> = {};
          const fullCardCustomFields = fullCard['customFields'] as Array<{_id: string; value: any}> | undefined;
          if (fullCardCustomFields) {
            for (const cf of fullCardCustomFields) {
              const fieldName = fieldIdToName[cf._id] || cf._id;
              mappedCustomFields[fieldName] = cf.value;
            }
          }

          const swimlaneId = fullCard.swimlaneId || fullCard['swimlaneId'];
          const swimlane = swimlaneId ? swimlaneMap.get(swimlaneId) : undefined;

          const detailedCard: DetailedCard = {
            id: fullCard._id,
            title: fullCard.title,
            description: fullCard.description || '',
            board: { id: board._id, title: board.title },
            list: { id: list._id, title: list.title },
            assignees: fullCard['assignees'] || [],
            startAt: fullCard['startAt'],
            endAt: fullCard['endAt'],
            dueAt: fullCard['dueAt'],
            createdAt: fullCard['createdAt'],
            customFields: mappedCustomFields
          };

          if (swimlane) {
            detailedCard.swimlane = { id: swimlane._id, title: swimlane.title };
          }

          if (includeComments) {
            // API returns comments newest-first, reverse to get oldest-first (chronological order)
            const sortedComments = [...comments].reverse();
            detailedCard.comments = await Promise.all(
              sortedComments.map(async (c: WekanComment) => ({
                id: c._id,
                author: await this.getUsername(c.authorId || c.userId || ''),
                text: c.text || c.comment || ''
              }))
            );
          }

          results.push(detailedCard);
        }
      }
    }

    return results;
  }

  /**
   * Get cards assigned to current user with full details (by IDs)
   */
  async getMyCards(
    userId: string,
    options: { boardId?: string; includeComments?: boolean } = {}
  ): Promise<DetailedCard[]> {
    return this.getDetailedCards(userId, {
      ...options,
      assigneeId: userId
    });
  }

  // ============================================
  // Name-based methods - more agent-friendly
  // ============================================

  /**
   * Find board by name (case-insensitive, partial match)
   */
  async findBoardByName(userId: string, boardName: string): Promise<WekanBoard | undefined> {
    const boards = await this.listBoards(userId);
    const lowerName = boardName.toLowerCase();
    return boards.find((b: WekanBoard) => b.title.toLowerCase().includes(lowerName));
  }

  /**
   * Find list by name in a board (case-insensitive, partial match)
   */
  async findListByName(boardId: string, listName: string): Promise<WekanList | undefined> {
    const lists = await this.listLists(boardId);
    const lowerName = listName.toLowerCase();
    return lists.find((l: WekanList) => l.title.toLowerCase().includes(lowerName));
  }

  /**
   * Get my cards with human-friendly filters (by names, not IDs)
   * This is the PRIMARY method for agents to use
   */
  async getMyCardsByName(
    userId: string,
    options: {
      boardName?: string;
      listName?: string;
      includeComments?: boolean;
    } = {}
  ): Promise<DetailedCard[]> {
    const { boardName, listName, includeComments = false } = options;
    const results: DetailedCard[] = [];

    // Get all boards
    let boards = await this.listBoards(userId);

    // Filter by board name if provided
    if (boardName) {
      const lowerBoardName = boardName.toLowerCase();
      boards = boards.filter((b: WekanBoard) => b.title.toLowerCase().includes(lowerBoardName));
      if (boards.length === 0) {
        return []; // No matching boards
      }
    }

    // Process each board
    for (const board of boards) {
      // Get board metadata in parallel
      const [lists, swimlanes, customFieldDefs] = await Promise.all([
        this.listLists(board._id),
        this.listSwimlanes(board._id),
        this.getCustomFields(board._id)
      ]);

      // Create lookup maps
      const swimlaneMap = new Map(swimlanes.map((s: WekanSwimlane) => [s._id, s]));
      const fieldIdToName: Record<string, string> = {};
      customFieldDefs.forEach((cf: WekanCustomField) => {
        fieldIdToName[cf._id] = cf.name;
      });

      // Filter lists by name if provided
      let listsToProcess = lists;
      if (listName) {
        const lowerListName = listName.toLowerCase();
        listsToProcess = lists.filter((l: WekanList) => l.title.toLowerCase().includes(lowerListName));
        if (listsToProcess.length === 0) {
          continue; // No matching lists in this board
        }
      }

      // Get cards from each list
      for (const list of listsToProcess) {
        const cards = await this.listCards(board._id, list._id);

        for (const card of cards) {
          // Filter by current user (my cards)
          const cardAssignees = card['assignees'] as string[] || [];
          if (!cardAssignees.includes(userId)) {
            continue;
          }

          // Get full card details
          const fullCard = await this.getCard(board._id, list._id, card._id);

          // Get comments if requested
          let comments: WekanComment[] = [];
          if (includeComments) {
            comments = await this.getCardComments(board._id, card._id).catch(() => []);
          }

          // Map custom fields
          const mappedCustomFields: Record<string, any> = {};
          const fullCardCustomFields = fullCard['customFields'] as Array<{_id: string; value: any}> | undefined;
          if (fullCardCustomFields) {
            for (const cf of fullCardCustomFields) {
              const fieldName = fieldIdToName[cf._id] || cf._id;
              mappedCustomFields[fieldName] = cf.value;
            }
          }

          const swimlaneId = fullCard.swimlaneId || fullCard['swimlaneId'];
          const swimlane = swimlaneId ? swimlaneMap.get(swimlaneId) : undefined;

          const detailedCard: DetailedCard = {
            id: fullCard._id,
            title: fullCard.title,
            description: fullCard.description || '',
            board: { id: board._id, title: board.title },
            list: { id: list._id, title: list.title },
            assignees: fullCard['assignees'] || [],
            startAt: fullCard['startAt'],
            endAt: fullCard['endAt'],
            dueAt: fullCard['dueAt'],
            createdAt: fullCard['createdAt'],
            customFields: mappedCustomFields
          };

          if (swimlane) {
            detailedCard.swimlane = { id: swimlane._id, title: swimlane.title };
          }

          if (includeComments) {
            // API returns comments newest-first, reverse to get oldest-first (chronological order)
            const sortedComments = [...comments].reverse();
            detailedCard.comments = await Promise.all(
              sortedComments.map(async (c: WekanComment) => ({
                id: c._id,
                author: await this.getUsername(c.authorId || c.userId || ''),
                text: c.text || c.comment || ''
              }))
            );
          }

          results.push(detailedCard);
        }
      }
    }

    return results;
  }

  /**
   * Get my pending cards (Backlog*, Em Desenvolvimento, and Merge lists)
   * This is the most useful method for daily workflow
   * Always includes comments with author names (not IDs)
   */
  async getMyPendingCards(
    userId: string,
    options: {
      boardName?: string;
    } = {}
  ): Promise<DetailedCard[]> {
    const { boardName } = options;
    const results: DetailedCard[] = [];

    // Get all boards
    let boards = await this.listBoards(userId);

    // Filter by board name if provided
    if (boardName) {
      const lowerBoardName = boardName.toLowerCase();
      boards = boards.filter((b: WekanBoard) => b.title.toLowerCase().includes(lowerBoardName));
      if (boards.length === 0) {
        return [];
      }
    }

    // Process each board
    for (const board of boards) {
      const [lists, swimlanes, customFieldDefs] = await Promise.all([
        this.listLists(board._id),
        this.listSwimlanes(board._id),
        this.getCustomFields(board._id)
      ]);

      // Create lookup maps
      const swimlaneMap = new Map(swimlanes.map((s: WekanSwimlane) => [s._id, s]));
      const fieldIdToName: Record<string, string> = {};
      customFieldDefs.forEach((cf: WekanCustomField) => {
        fieldIdToName[cf._id] = cf.name;
      });

      // Filter lists: starts with "Backlog" OR equals "Em Desenvolvimento" OR equals "Merge"
      const pendingLists = lists.filter((l: WekanList) => {
        const lowerTitle = l.title.toLowerCase();
        return lowerTitle.startsWith('backlog') || lowerTitle === 'em desenvolvimento' || lowerTitle === 'merge';
      });

      if (pendingLists.length === 0) {
        continue;
      }

      // Get cards from pending lists
      for (const list of pendingLists) {
        let cards: WekanCard[];
        try {
          cards = await this.listCards(board._id, list._id);
        } catch (e) {
          // Skip list on error (e.g. transient 502) instead of aborting entire operation
          continue;
        }

        for (const card of cards) {
          // Filter by current user
          const cardAssignees = card['assignees'] as string[] || [];
          if (!cardAssignees.includes(userId)) {
            continue;
          }

          // Skip cards with empty description (not ready to be worked on)
          if (!card.description || card.description.trim() === '') {
            continue;
          }

          // Get full card details and comments in parallel
          const [fullCard, rawComments] = await Promise.all([
            this.getCard(board._id, list._id, card._id),
            this.getCardComments(board._id, card._id).catch(() => [])
          ]);

          // API returns comments newest-first, reverse to get oldest-first (chronological order)
          const sortedRawComments = [...rawComments].reverse();

          // Check if last comment was from the connected user - if so, skip this card
          // (user is waiting for someone else to respond)
          if (sortedRawComments.length > 0) {
            const lastComment = sortedRawComments[sortedRawComments.length - 1]!;
            const lastCommentAuthorId = lastComment.authorId || lastComment.userId || '';
            if (lastCommentAuthorId === userId) {
              continue;
            }
          }

          const comments: CardComment[] = await Promise.all(
            sortedRawComments.map(async (c: WekanComment) => ({
              id: c._id,
              author: await this.getUsername(c.authorId || c.userId || ''),
              text: c.text || c.comment || ''
            }))
          );

          // Map custom fields
          const mappedCustomFields: Record<string, any> = {};
          const fullCardCustomFields = fullCard['customFields'] as Array<{_id: string; value: any}> | undefined;
          if (fullCardCustomFields) {
            for (const cf of fullCardCustomFields) {
              const fieldName = fieldIdToName[cf._id] || cf._id;
              mappedCustomFields[fieldName] = cf.value;
            }
          }

          // Skip card if no comments AND both 'uuid' and 'PR' fields are filled (work is complete)
          // This rule only applies when there are no comments - if there are comments, the last comment rule takes precedence
          if (sortedRawComments.length === 0 && mappedCustomFields['uuid'] && mappedCustomFields['PR']) {
            continue;
          }

          const swimlaneId = fullCard.swimlaneId || fullCard['swimlaneId'];
          const swimlane = swimlaneId ? swimlaneMap.get(swimlaneId) : undefined;

          // Get card creator info
          const creatorId = fullCard['userId'] as string | undefined;
          const creatorName = creatorId ? await this.getUsername(creatorId) : 'Unknown';

          const detailedCard: DetailedCard = {
            id: fullCard._id,
            title: fullCard.title,
            description: fullCard.description || '',
            board: { id: board._id, title: board.title },
            list: { id: list._id, title: list.title },
            assignees: fullCard['assignees'] || [],
            startAt: fullCard['startAt'],
            endAt: fullCard['endAt'],
            dueAt: fullCard['dueAt'],
            createdAt: fullCard['createdAt'],
            customFields: mappedCustomFields,
            comments
          };

          if (creatorId) {
            detailedCard.createdBy = { id: creatorId, name: creatorName };
          }

          if (swimlane) {
            detailedCard.swimlane = { id: swimlane._id, title: swimlane.title };
          }

          results.push(detailedCard);
        }
      }
    }

    return results;
  }

  // ============================================
  // Update methods
  // ============================================

  /**
   * Add a comment to a card using only the cardId (finds boardId automatically)
   * This simplifies the agent workflow - no need to know the boardId
   */
  async addCommentByCardId(
    userId: string,
    cardId: string,
    comment: string
  ): Promise<{ ok: boolean; commentId?: string; error?: string }> {
    // Search through all boards to find the card
    const boards = await this.listBoards(userId);

    for (const board of boards) {
      const lists = await this.listLists(board._id);
      for (const list of lists) {
        const cards = await this.listCards(board._id, list._id);
        const found = cards.find((c: WekanCard) => c._id === cardId);
        if (found) {
          // Found the card! Add the comment
          const res = await this.commentCard(board._id, cardId, userId, comment);
          return { ok: true, commentId: res._id };
        }
      }
    }

    return { ok: false, error: `Card not found: ${cardId}` };
  }

  /**
   * Move a card to another list using only cardId and list name.
   * Automatically finds the board and current list.
   */
  async moveCardToList(
    userId: string,
    cardId: string,
    destListName: string
  ): Promise<{ ok: boolean; message: string; fromList?: string; toList?: string }> {
    // Search through all boards to find the card
    const boards = await this.listBoards(userId);

    for (const board of boards) {
      const lists = await this.listLists(board._id);
      for (const list of lists) {
        const cards = await this.listCards(board._id, list._id);
        const found = cards.find((c: WekanCard) => c._id === cardId);
        if (found) {
          // Found the card! Now find the destination list by name
          const lowerDestName = destListName.toLowerCase();
          const destList = lists.find((l: WekanList) =>
            l.title.toLowerCase().includes(lowerDestName)
          );

          if (!destList) {
            const availableLists = lists.map((l: WekanList) => l.title).join(', ');
            return {
              ok: false,
              message: `List not found: "${destListName}". Available lists: ${availableLists}`
            };
          }

          // Check if already in destination list
          if (list._id === destList._id) {
            return {
              ok: true,
              message: `Card is already in list "${destList.title}"`,
              fromList: list.title,
              toList: destList.title
            };
          }

          // Move the card
          await this.moveCard(board._id, list._id, cardId, { listId: destList._id });

          return {
            ok: true,
            message: `Card moved successfully`,
            fromList: list.title,
            toList: destList.title
          };
        }
      }
    }

    return { ok: false, message: `Card not found: ${cardId}` };
  }

  /**
   * Update a custom field value on a card by field name
   * This is the main method for updating card fields like Downstream, Upstream, Planejamento, etc.
   */
  async updateCardField(
    boardId: string,
    listId: string,
    cardId: string,
    fieldName: string,
    value: any
  ): Promise<{ success: boolean; message: string }> {
    // Get current card details
    const card = await this.getCard(boardId, listId, cardId);

    // Get custom field definitions to map name to ID
    const customFieldDefs = await this.getCustomFields(boardId);
    const fieldDef = customFieldDefs.find((cf: WekanCustomField) =>
      cf.name.toLowerCase() === fieldName.toLowerCase()
    );

    if (!fieldDef) {
      return {
        success: false,
        message: `Custom field not found: ${fieldName}. Available fields: ${customFieldDefs.map((cf: WekanCustomField) => cf.name).join(', ')}`
      };
    }

    // Get current custom fields from card
    const currentCustomFields = (card['customFields'] as Array<{_id: string; value: any}>) || [];

    // Update or add the field
    let fieldFound = false;
    const updatedCustomFields = currentCustomFields.map(cf => {
      if (cf._id === fieldDef._id) {
        fieldFound = true;
        return { _id: cf._id, value: value };
      }
      return { _id: cf._id, value: cf.value };
    });

    // If field wasn't in card's custom fields, add it
    if (!fieldFound) {
      updatedCustomFields.push({ _id: fieldDef._id, value: value });
    }

    // Send PUT request to update card
    await this.put(`/api/boards/${boardId}/lists/${listId}/cards/${cardId}`, {
      customFields: updatedCustomFields
    });

    return {
      success: true,
      message: `Field "${fieldName}" updated successfully`
    };
  }

}
