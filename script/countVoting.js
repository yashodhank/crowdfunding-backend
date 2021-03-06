//
// This script counts the ballots of a vote and upserts vote.result
// params
//   vote name
//   optional: message
//   optional: winner's votingOption.name (in case of final vote)
//   optional: video: hls, mp4, youtube, subtitles (if given, hls and mp4 are required)
//   optional: no-freeze: don't freeze turnout and stats into result
//
// usage
// cf_server  node script/countVoting.js --name NAME [--message MESSAGE] [--winner WINNER] [--hls url] [--mp4 url] [--youtube url] [--subtitles url] [--no-freeze]
//

require('dotenv').config()
const PgDb = require('../lib/pgdb')
const Voting = require('../graphql/resolvers/Voting')
const VoteStats = require('../graphql/resolvers/VoteStats')
const util = require('util')

PgDb.connect().then(async (pgdb) => {
  const argv = require('minimist')(process.argv.slice(2))

  const {name, message, winner: winnerName} = argv
  const freeze = argv.freeze !== false

  if (!name) { throw new Error('name must be provided') }

  let video
  if (argv.hls || argv.mp4 || argv.youtube || argv.subtitles || argv.poster) {
    if (!argv.hls || !argv.mp4) {
      throw new Error('hls and mp4 are required for video')
    }
    video = {
      hls: argv.hls,
      mp4: argv.mp4,
      youtube: argv.youtube,
      subtitles: argv.subtitles,
      poster: argv.poster
    }
  }

  console.log('counting vote...')

  const transaction = await pgdb.transactionBegin()
  try {
    const voting = await pgdb.public.votings.findOne({ name })
    if (!voting) {
      throw new Error(`a voting with the name '${name}' could not be found!`)
    }

    const counts = await pgdb.query(`
      SELECT id, name, count FROM (
        SELECT DISTINCT ON (id, name) id, name, count FROM (

            SELECT
              vo.id AS id,
              vo.name AS name,
              0 AS count
            FROM
              "votingOptions" vo
            WHERE
              vo."votingId" = :votingId

          UNION ALL

            SELECT
              vo.id AS id,
              vo.name AS name,
              COUNT(DISTINCT(m."userId")) AS count
            FROM
              "votingOptions" vo
            JOIN
              ballots b
              ON vo.id=b."votingOptionId"
            JOIN
              memberships m
              ON m."userId" = b."userId"
            WHERE
              vo."votingId" = :votingId

          GROUP BY
            1, 2
          ORDER BY
            3 DESC
        ) AS subquery
      ) as query
      ORDER BY
        3 DESC
    `, {
      votingId: voting.id
    })

    let winner
    if (counts[0].count === counts[1].count) { // undecided
      if (!winnerName) {
        throw new Error(`voting is undecided, you must provide the winners votingOption name as a parameter!`)
      }
      winner = counts.find(c => c.name === winnerName)
      if (!winner) {
        throw new Error(`voting is undecided but a votingOption with the name '${winnerName}' could not be found!`)
      }
    } else {
      winner = counts[0]
    }

    const turnout = freeze
      ? await Voting.turnout(voting, null, {pgdb})
      : null
    const stats = freeze
      ? {
        ages: await VoteStats.ages({voting}, null, {pgdb}),
        countries: await VoteStats.countries({voting}, null, {pgdb}),
        chCantons: await VoteStats.chCantons({voting}, null, {pgdb})
      }
      : null

    const newVoting = await pgdb.public.votings.updateAndGetOne({
      id: voting.id
    }, {
      result: {
        options: counts.map(c => Object.assign({}, c, {
          winner: (c.id === winner.id)
        })),
        updatedAt: new Date(),
        createdAt: voting.result ? voting.result.createdAt : new Date(),
        message, // ignored by postgres if null
        video,
        turnout,
        stats
      }
    })
    console.log('finished! The result is:')
    console.log(util.inspect(newVoting.result, {depth: 3}))
    console.log('🎉🎉🎉🎉🎉🎉')
  } catch (e) {
    await transaction.transactionRollback()
    throw e
  }
}).then(() => {
  process.exit()
}).catch(e => {
  console.error(e)
  process.exit(1)
})
